// ==============================================
// AQUÍ PAULI — Tilopay (tarjeta, hosted payment page, cobro en COLONES)
//
// ESTADO: apagado. Solo se activa con Firestore config/payments.tilopay.enabled === true.
//
// Funciones (callables, us-central1):
//   tilopayGetConfig     → { enabled, mode } (sin secretos)
//   tilopayCreatePayment → reserva un intento (transacción), recalcula el total en el servidor (pricing.js) y devuelve la URL de pago
//   tilopayConfirm       → confirma con POST /consult (no confía en lo que vuelve por el navegador)
//
// Reglas de seguridad (ver docs/payments-tilopay.md):
//   - Modo "test": solo cuentas admin/tester (users_roles) y NUNCA marca el pedido como "pagado" (queda "test_paid").
//   - Solo se acredita un pago con capture == "Capture", monto/moneda del PROPIO intento, entorno coherente y
//     transacción única (registro tilopayTx/{entorno_idTilopay}). Authorize/incompleto → revisión, no pagado.
//   - Cada intento (a1, a2…) se reserva en una transacción ANTES de llamar a processPayment.
//
// Config:
//   Secrets (Firebase): TILOPAY_API_USER, TILOPAY_API_PASSWORD, TILOPAY_KEY
//   Param (opcional):   TILOPAY_RETURN_BASE (default https://aquipauli.com)
//   Firestore config/payments → { tilopay: { enabled: false, mode: "test"|"live" } }
//   mode "test": la opción solo aparece en /checkout?tilopay_test=1
// ==============================================

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { db } = require("./utils");
const { computeTotalsCRC } = require("./lib/pricing");
const tp = require("./lib/tilopayApi");

const TILOPAY_API_USER = defineSecret("TILOPAY_API_USER");
const TILOPAY_API_PASSWORD = defineSecret("TILOPAY_API_PASSWORD");
const TILOPAY_KEY = defineSecret("TILOPAY_KEY");
const TILOPAY_RETURN_BASE = defineString("TILOPAY_RETURN_BASE", { default: "https://aquipauli.com" });

const OPTS = { cors: true, invoker: "public" };
const SECRETS = [TILOPAY_API_USER, TILOPAY_API_PASSWORD, TILOPAY_KEY];

async function readConfig() {
  try {
    const s = await db.collection("config").doc("payments").get();
    const c = (s.exists && s.data().tilopay) || {};
    // Seguro por defecto: si falta o no dice exactamente "live", se trata como "test".
    return { enabled: c.enabled === true, mode: c.mode === "live" ? "live" : "test", merchantId: String(c.merchantId || "") };
  } catch (e) {
    console.warn("[tilopay] config/payments:", e.message);
    return { enabled: false, mode: "test", merchantId: "" };
  }
}

// ---------- roles (mismo patrón que payments.js/orders.js: users_roles/{uid}.role) ----------
const TEST_ROLES = ["admin", "tester"];
async function requireTester(uid) {
  let role = null;
  try {
    const snap = await db.collection("users_roles").doc(uid).get();
    role = snap.exists ? snap.data().role : null;
  } catch (e) {
    console.warn("[tilopay] users_roles:", e.message);
  }
  if (!TEST_ROLES.includes(role)) throw new HttpsError("permission-denied", "El pago con tarjeta no está disponible.");
}

// ---------- estado de intentos ----------
const CONSULTABLE = new Set(["reserved", "open", "pending_capture", "pending_reconciliation"]);
const UNRESOLVED = new Set(["reserved", "open"]);
const BLOCKS_NEW_ATTEMPT = new Set(["approved", "test_paid", "pending_capture", "pending_reconciliation", "mismatch"]);
const REVIEW_STATES = new Set(["pending_capture", "pending_reconciliation", "mismatch"]);
const STALE_OPEN_MS = 30 * 60 * 1000;
const STALE_RESERVED_MS = 2 * 60 * 1000;
const PAID_STATUSES = ["pagado", "por_preparar", "enviado", "entregado"];

const isPaidOrder = (o) => ["pagado", "verificado"].includes(o?.paymentStatus) || PAID_STATUSES.includes(o?.status);
const attemptsOf = (o) => Object.entries(o?.tilopay?.attemptsById || {}).map(([key, a]) => ({ ...a, key })).sort((x, y) => x.n - y.n);
const ageMs = (a) => Date.now() - Date.parse(a.createdAt || 0);
const isOwner = (o, uid) => o.uid === uid || o.customerUid === uid;

async function loadOwnedOrder(request, orderId) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  if (!orderId || typeof orderId !== "string") throw new HttpsError("invalid-argument", "orderId requerido.");
  const ref = db.collection("orders").doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
  const order = snap.data();
  if (!isOwner(order, request.auth.uid)) throw new HttpsError("permission-denied", "No tienes acceso a este pedido.");
  return { ref, order };
}

async function authToken() {
  const apiUser = TILOPAY_API_USER.value();
  const password = TILOPAY_API_PASSWORD.value();
  if (!apiUser || !password || !TILOPAY_KEY.value()) throw new HttpsError("failed-precondition", "Tilopay no está configurado.");
  try {
    return await tp.getToken({ apiUser, password });
  } catch (e) {
    console.error("[tilopay] auth:", e.message);
    throw new HttpsError("unavailable", "No se pudo conectar con Tilopay.");
  }
}

/** Correcciones de precio del servidor (mismo comportamiento de antes), sin escribir. */
function priceCorrection(order, totals, now) {
  if (order.total === totals.total) return {};
  return {
    subtotal: totals.subtotal,
    shippingCost: totals.shippingCost,
    total: totals.total,
    priceCorrectedByServer: { previousTotal: order.total ?? null, at: now },
    itemsSummary: (order.itemsSummary || []).map((s) => {
      const l = totals.lines.find((x) => x.productId === s.productId && x.variantId === s.variantId);
      return l ? { ...s, price: l.unitPrice, lineTotal: l.lineTotal } : s;
    }),
  };
}

// ----------------------------------------------
exports.tilopayGetConfig = onCall({ ...OPTS, secrets: [] }, async () => {
  const { enabled, mode } = await readConfig();
  return { enabled, mode };
});

// ----------------------------------------------
exports.tilopayCreatePayment = onCall({ ...OPTS, secrets: SECRETS }, async (request) => {
  const cfg = await readConfig();
  if (!cfg.enabled) throw new HttpsError("failed-precondition", "El pago con tarjeta no está disponible.");
  if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  const uid = request.auth.uid;
  // El modo de PRUEBAS solo lo puede usar admin/tester, aunque alguien conozca ?tilopay_test=1.
  if (cfg.mode === "test") await requireTester(uid);

  const { orderId } = request.data || {};
  const { ref, order } = await loadOwnedOrder(request, orderId);
  if (isPaidOrder(order)) throw new HttpsError("failed-precondition", "Este pedido ya fue pagado.");
  if (order.paymentStatus === "test_paid") throw new HttpsError("failed-precondition", "Este pedido ya tiene un pago de prueba.");

  // Items y envío vienen del pedido guardado; los PRECIOS se recalculan en el servidor (CRC).
  const itemsSnap = await ref.collection("items").get();
  const items = itemsSnap.docs.map((d) => d.data());
  let totals;
  try {
    totals = await computeTotalsCRC(db, items, { canton: order.shippingAddress?.canton, shippingType: order.shippingType });
  } catch (e) {
    throw new HttpsError("failed-precondition", e.message);
  }

  const token = await authToken();

  // Intentos viejos sin resolver: se consultan ANTES de abrir otro (evita cobrar dos veces).
  const stale = attemptsOf(order).filter((a) => UNRESOLVED.has(a.status)
    && ageMs(a) > (a.url ? STALE_OPEN_MS : STALE_RESERVED_MS));
  if (stale.length) {
    await reconcile({ ref, orderId, order, cfg, token, keys: stale.map((a) => a.key) });
  }

  // 1) RESERVA del intento en una transacción (antes de llamar a processPayment).
  const reservation = await db.runTransaction(async (t) => {
    const cur = await t.get(ref);
    if (!cur.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
    const o = cur.data();
    if (!isOwner(o, uid)) throw new HttpsError("permission-denied", "No tienes acceso a este pedido.");
    if (isPaidOrder(o)) throw new HttpsError("failed-precondition", "Este pedido ya fue pagado.");
    if (o.paymentStatus === "test_paid") throw new HttpsError("failed-precondition", "Este pedido ya tiene un pago de prueba.");

    const prev = o.tilopay || {};
    const atts = { ...(prev.attemptsById || {}) };
    const list = Object.entries(atts).map(([key, a]) => ({ ...a, key }));
    if (list.some((a) => BLOCKS_NEW_ATTEMPT.has(a.status))) {
      throw new HttpsError("failed-precondition", "Este pedido ya tiene un pago con tarjeta en proceso o en revisión. Escríbenos por WhatsApp.");
    }

    const now = new Date().toISOString();
    const correction = priceCorrection(o, totals, now);
    const version = tp.orderVersion({ ...o, ...correction });

    // Reutilizar el intento abierto (mismo monto, versión y modo) en vez de crear T2 mientras T1 sigue sin resolver.
    for (const a of list.filter((x) => UNRESOLVED.has(x.status))) {
      const same = a.orderVersion === version && a.amount === totals.total && a.mode === cfg.mode;
      if (!same) continue;
      if (a.url && ageMs(a) <= STALE_OPEN_MS) return { reuse: a };
      if (!a.url && ageMs(a) <= STALE_RESERVED_MS) {
        throw new HttpsError("aborted", "Ya hay un pago en proceso para este pedido. Espera unos segundos e inténtalo de nuevo.");
      }
    }
    // Los demás intentos sin resolver quedan marcados: siguen consultables, pero ya no son el actual.
    for (const a of list.filter((x) => UNRESOLVED.has(x.status))) {
      atts[a.key] = a.url ? { ...atts[a.key], superseded: true } : { ...atts[a.key], status: "abandoned", reason: "Sin URL de pago emitida" };
    }

    const n = (Number(prev.attemptCount) || list.length) + 1;
    const key = `a${n}`;
    const attempt = {
      n, orderNumber: tp.tilopayReference(orderId, n), // referencia única derivada del id del documento
      amount: totals.total, currency: "CRC", orderVersion: version, mode: cfg.mode,
      status: "reserved", createdAt: now, createdBy: uid,
    };
    atts[key] = attempt;
    t.update(ref, {
      ...correction,
      paymentMethod: "tilopay",
      tilopay: { ...prev, mode: cfg.mode, attemptCount: n, currentAttempt: key, currency: "CRC", crcTotal: totals.total, attemptsById: atts },
      updatedAt: now,
    });
    return { attempt, key };
  });

  if (reservation.reuse) {
    return { url: reservation.reuse.url, crcTotal: reservation.reuse.amount, currency: "CRC", reused: true };
  }
  const { attempt, key } = reservation;

  // 2) Llamada a Tilopay (fuera de la transacción). Si falla por red, el intento queda "reserved" y se consulta después.
  const base = String(TILOPAY_RETURN_BASE.value() || "https://aquipauli.com").replace(/\/+$/, "");
  const redirect = `${base}/tilopay/retorno/${encodeURIComponent(orderId)}`;
  const payload = tp.buildProcessPayload({
    key: TILOPAY_KEY.value(), redirect, orderId, order, orderNumber: attempt.orderNumber, crcTotal: attempt.amount,
  });
  let res;
  try {
    res = await tp.tpFetch("/api/v1/processPayment", { token, body: payload });
  } catch (e) {
    console.error("[tilopay] processPayment sin respuesta:", e.message);
    throw new HttpsError("unavailable", "No se pudo conectar con Tilopay. Intenta de nuevo en unos minutos.");
  }
  const url = res.data?.url;
  let urlOk = false;
  try { const u = new URL(url); urlOk = u.protocol === "https:" && /(^|\.)tilopay\.com$/.test(u.hostname); } catch { /* url inválida */ }
  if (!res.ok || !urlOk) {
    console.error("[tilopay] processPayment falló:", res.status, JSON.stringify(res.data).slice(0, 500));
    await setAttemptStatus(ref, key, "reserved", { status: "create_failed", reason: `processPayment ${res.status}` });
    throw new HttpsError("internal", "Tilopay no pudo crear el pago.");
  }
  await setAttemptStatus(ref, key, "reserved", { status: "open", url, openedAt: new Date().toISOString() });

  return { url, crcTotal: attempt.amount, currency: "CRC" };
});

/** Cambia un intento solo si sigue en el estado esperado (transacción). */
async function setAttemptStatus(ref, key, expected, patch) {
  await db.runTransaction(async (t) => {
    const cur = await t.get(ref);
    const tpd = cur.data()?.tilopay;
    const a = tpd?.attemptsById?.[key];
    if (!a || a.status !== expected) return;
    t.update(ref, { tilopay: { ...tpd, attemptsById: { ...tpd.attemptsById, [key]: { ...a, ...patch } } }, updatedAt: new Date().toISOString() });
  });
}

const num2 = (v) => Math.round(Number(v) * 100) / 100;
const withoutNulls = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

/**
 * Aplica el resultado de consult de UN intento. Todo en una transacción:
 *  - idempotente (si otro llamado ya lo resolvió, no hace nada),
 *  - nunca baja de estado un pedido ya pagado,
 *  - en modo test jamás escribe paymentStatus/status "pagado",
 *  - registro tilopayTx/{entorno_idTilopay}: una transacción de Tilopay no puede acreditar dos pedidos.
 * @returns {{kind:"paid"|"test_paid"|"already_paid"|"review"|"declined"|"not_found"|"noop"}}
 */
async function applyAttemptResult(ref, orderId, key, r) {
  return db.runTransaction(async (t) => {
    const cur = await t.get(ref);
    const o = cur.data();
    const tpd = JSON.parse(JSON.stringify(o.tilopay || {}));
    const att = tpd.attemptsById?.[key];
    if (!att || !CONSULTABLE.has(att.status)) return { kind: "noop" };
    if (r.state === "not_found") return { kind: "not_found" };

    const now = new Date().toISOString();
    const tx = r.tx || {};
    const paidAlready = isPaidOrder(o);
    const testPaidAlready = o.paymentStatus === "test_paid";
    const live = att.mode === "live";
    const known = withoutNulls({
      lastCheckedAt: now, returnedOrderNumber: tx.orderNumber, idTilopay: tx.id_tilopay ?? tx.id, environment: tx.environment,
      capture: tx.capture, merchantId: tx.merchantId, auth: tx.auth, card: tx.card,
    });
    const setAtt = (patch) => { tpd.attemptsById[key] = { ...att, ...known, ...patch }; };
    const orderUpdate = { updatedAt: now };

    // Registro de transacciones (lecturas ANTES de cualquier escritura).
    let regRef = null; let reg = null;
    const hasTx = (r.state === "approved" || r.state === "pending_capture") && (r.env === "test" || r.env === "live");
    if (hasTx) {
      regRef = db.collection("tilopayTx").doc(`${r.env}_${String(tx.id_tilopay).replace(/[^A-Za-z0-9]/g, "")}`);
      const rs = await t.get(regRef);
      reg = rs.exists ? rs.data() : null;
    }
    const claim = (status) => {
      if (!regRef) return;
      const data = { orderId, attempt: key, orderNumber: att.orderNumber, env: r.env, idTilopay: tx.id_tilopay, amount: num2(tx.amount), status, updatedAt: now };
      if (reg) t.update(regRef, data); else t.set(regRef, { ...data, createdAt: now });
    };
    const summary = (status, reason) => {
      if (paidAlready || testPaidAlready) return;
      tpd.status = status; if (reason) tpd.reason = reason;
    };
    const review = (status, reason) => {
      setAtt({ status, reason });
      summary(status, reason);
      if (live && !paidAlready && !testPaidAlready) {
        orderUpdate.paymentStatus = "verificando";
        if (["pendiente_pago", "revision_manual", undefined].includes(o.status)) orderUpdate.status = "revision_manual";
        orderUpdate.notes = [o.notes, `Tilopay: revisar manualmente. ${reason}`].filter(Boolean).join(" | ");
      }
      if (live && paidAlready && String(tx.code) === "1") {
        // Dinero cobrado por Tilopay en un pedido que ya estaba pagado: hay que revisarlo/reembolsarlo a mano.
        tpd.duplicatePaymentNeedsReview = true;
        tpd.duplicateReason = `Cobro ${tx.id_tilopay ?? "?"} (${tx.amount} ${tx.currency || ""}) en un pedido ya pagado: ${reason}`;
      }
      console.error("[tilopay] revisión:", orderId, key, status, reason);
      t.update(ref, { ...orderUpdate, tilopay: tpd });
      return { kind: "review" };
    };

    if (r.state === "declined") {
      setAtt({ status: "declined" });
      summary("declined");
      t.update(ref, { ...orderUpdate, tilopay: tpd });
      return { kind: "declined" };
    }
    if (r.state === "mismatch" || r.state === "pending_reconciliation") return review(r.state, r.reason);

    // approved | pending_capture: la transacción debe ser única y el pedido no debe haber cambiado.
    if (reg && (reg.orderId !== orderId || reg.attempt !== key)) {
      return review("mismatch", `La transacción ${r.env}_${tx.id_tilopay} ya está registrada en otro pedido o intento.`);
    }
    if (tp.orderVersion(o) !== att.orderVersion) {
      claim("needs_review");
      return review("mismatch", "El pedido cambió después de iniciar el pago; no se acredita automáticamente.");
    }
    if (r.state === "pending_capture") {
      claim("pending_capture");
      return review("pending_capture", r.reason);
    }

    // approved (capturado)
    const validatedAmount = num2(tx.amount); // lo que Tilopay cobró (no el total actual del pedido)
    if (!live) {
      // MODO PRUEBAS: nunca "pagado". No dispara inventario, Telegram, correo ni CRM.
      claim("test_paid");
      setAtt({ status: "test_paid", validatedAmount, testPaidAt: now });
      if (!paidAlready) { tpd.status = "test_paid"; orderUpdate.paymentStatus = "test_paid"; }
      t.update(ref, { ...orderUpdate, tilopay: tpd });
      return { kind: "test_paid" };
    }
    claim("approved");
    if (paidAlready) {
      // Ya estaba pagado (otra vía u otro intento): se registra y se marca para revisar un posible doble cobro.
      setAtt({ status: "approved", validatedAmount, duplicate: true });
      if (String(o.paymentTransactionId) !== String(tx.id_tilopay)) {
        tpd.duplicatePaymentNeedsReview = true;
        tpd.duplicateReason = `Cobro adicional ${tx.id_tilopay} (${validatedAmount} CRC) en un pedido ya pagado.`;
      }
      t.update(ref, { ...orderUpdate, tilopay: tpd });
      return { kind: "already_paid" };
    }
    setAtt({ status: "approved", validatedAmount, confirmedAt: now });
    Object.assign(tpd, {
      status: "approved", orderNumber: att.orderNumber, tilopayId: tx.id_tilopay ?? null, auth: tx.auth || "",
      card: tx.card || "", environment: tx.environment || "", commission: tx.commission ?? null,
      netToLiquidate: tx.net_to_liquidate ?? null, confirmedAt: now,
    });
    t.update(ref, {
      ...orderUpdate,
      paymentMethod: "tilopay",
      paymentStatus: "pagado",
      status: "pagado", // dispara onOrderStatusChange (inventario, notificaciones, CRM) — SOLO en modo live
      paymentAmount: validatedAmount,
      paymentTransactionId: String(tx.id_tilopay),
      paymentDate: now,
      reconciliationResult: "tilopay_consult",
      reconciliationDetails: { method: "tilopay", orderNumber: att.orderNumber, auth: tx.auth || "", environment: tx.environment || "" },
      tilopay: tpd,
    });
    return { kind: "paid" };
  });
}

/** Consulta a Tilopay los intentos consultables y aplica cada resultado. Devuelve los resultados. */
async function reconcile({ ref, orderId, order, cfg, token, keys }) {
  const targets = attemptsOf(order)
    .filter((a) => CONSULTABLE.has(a.status) && (!keys || keys.includes(a.key)))
    .sort((x, y) => y.n - x.n) // más reciente primero
    .slice(0, 5);
  const outcomes = [];
  for (const a of targets) {
    const body = { key: TILOPAY_KEY.value(), orderNumber: a.orderNumber };
    if (cfg.merchantId) body.merchantId = cfg.merchantId;
    const res = await tp.tpFetch("/api/v1/consult", { token, body });
    if (!res.ok && !tp.looksNotFound(res.data)) {
      console.error("[tilopay] consult falló:", res.status, JSON.stringify(res.data).slice(0, 300));
      throw new HttpsError("internal", "No se pudo consultar el pago en Tilopay.");
    }
    const r = tp.interpretConsult(res.data, { orderNumber: a.orderNumber, amount: a.amount, mode: a.mode, merchantId: cfg.merchantId });
    outcomes.push(await applyAttemptResult(ref, orderId, a.key, r));
  }
  return outcomes;
}

function summarize(order) {
  if (isPaidOrder(order)) return "paid";
  if (order.paymentStatus === "test_paid") return "test_paid";
  const list = attemptsOf(order);
  if (list.some((a) => REVIEW_STATES.has(a.status))) return "review";
  const last = list[list.length - 1];
  if (last?.status === "declined") return "declined";
  return "not_found";
}

// ----------------------------------------------
exports.tilopayConfirm = onCall({ ...OPTS, secrets: SECRETS }, async (request) => {
  const { orderId } = request.data || {};
  const { ref, order } = await loadOwnedOrder(request, orderId);
  const attempts = attemptsOf(order);
  if (!attempts.length) throw new HttpsError("failed-precondition", "Este pedido no tiene un pago Tilopay iniciado.");
  // Pedidos con intentos de PRUEBA solo los puede confirmar admin/tester.
  if (attempts.some((a) => a.mode === "test")) await requireTester(request.auth.uid);
  if (isPaidOrder(order)) return { result: "already_paid", message: "Este pedido ya fue pagado." };

  const cfg = await readConfig();
  const token = await authToken();
  const outcomes = await reconcile({ ref, orderId, order, cfg, token });
  const justPaid = outcomes.some((o) => o.kind === "paid");

  const fresh = (await ref.get()).data();
  switch (summarize(fresh)) {
    case "paid":
      return justPaid ? { result: "paid", message: "Pago con tarjeta recibido." } : { result: "already_paid", message: "Este pedido ya fue pagado." };
    case "test_paid":
      return { result: "test_paid", message: "Pago de PRUEBA recibido. No se cobró dinero real y el pedido NO se marcó como pagado." };
    case "review":
      return { result: "review", message: "Tu pago está en revisión. Te avisaremos por WhatsApp." };
    case "declined":
      return { result: "declined", retry: true, message: "El banco no aprobó el pago. Puedes intentar con otra tarjeta." };
    default:
      return { result: "not_found", retry: true, message: "No encontramos un pago completado. Si cancelaste, puedes intentarlo de nuevo." };
  }
});
