// ==============================================
// AQUÍ PAULI — Tilopay (tarjeta, hosted payment page, cobro en COLONES)
//
// ESTADO: apagado. Solo se activa con Firestore config/payments.tilopay.enabled === true.
//
// Funciones (callables, us-central1):
//   tilopayGetConfig     → { enabled, mode } (sin secretos)
//   tilopayCreatePayment → recalcula el total en el servidor (pricing.js) y devuelve la URL de pago
//   tilopayConfirm       → confirma con POST /consult (no confía en lo que vuelve por el navegador)
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
    return { enabled: c.enabled === true, mode: c.mode === "test" ? "test" : "live" };
  } catch (e) {
    console.warn("[tilopay] config/payments:", e.message);
    return { enabled: false, mode: "live" };
  }
}

async function loadOwnedOrder(request, orderId) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  if (!orderId || typeof orderId !== "string") throw new HttpsError("invalid-argument", "orderId requerido.");
  const ref = db.collection("orders").doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
  const order = snap.data();
  if (order.uid !== request.auth.uid && order.customerUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "No tienes acceso a este pedido.");
  }
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

// ----------------------------------------------
exports.tilopayGetConfig = onCall({ ...OPTS, secrets: [] }, async () => readConfig());

// ----------------------------------------------
exports.tilopayCreatePayment = onCall({ ...OPTS, secrets: SECRETS }, async (request) => {
  const cfg = await readConfig();
  if (!cfg.enabled) throw new HttpsError("failed-precondition", "El pago con tarjeta no está disponible.");
  const { orderId } = request.data || {};
  const { ref, order } = await loadOwnedOrder(request, orderId);
  if (order.paymentStatus === "pagado") throw new HttpsError("failed-precondition", "Este pedido ya fue pagado.");

  // Items y envío vienen del pedido guardado; los PRECIOS se recalculan en el servidor (CRC).
  const itemsSnap = await ref.collection("items").get();
  const items = itemsSnap.docs.map((d) => d.data());
  let totals;
  try {
    totals = await computeTotalsCRC(db, items, { canton: order.shippingAddress?.canton, shippingType: order.shippingType });
  } catch (e) {
    throw new HttpsError("failed-precondition", e.message);
  }

  const prev = order.tilopay || {};
  const attempt = (prev.attempts || 0) + 1;
  const orderNumber = tp.tilopayOrderNumber(order, attempt);
  const base = String(TILOPAY_RETURN_BASE.value() || "https://aquipauli.com").replace(/\/+$/, "");
  const redirect = `${base}/tilopay/retorno/${encodeURIComponent(orderId)}`;

  const token = await authToken();
  const payload = tp.buildProcessPayload({
    key: TILOPAY_KEY.value(), redirect, orderId, order, orderNumber, crcTotal: totals.total,
  });
  const res = await tp.tpFetch("/api/v1/processPayment", { token, body: payload });
  const url = res.data?.url;
  if (!res.ok || !url) {
    console.error("[tilopay] processPayment falló:", res.status, JSON.stringify(res.data).slice(0, 500));
    throw new HttpsError("internal", "Tilopay no pudo crear el pago.");
  }

  const now = new Date().toISOString();
  const update = {
    paymentMethod: "tilopay",
    tilopay: {
      mode: cfg.mode,
      attempts: attempt,
      orderNumber,
      orderNumbers: [...(prev.orderNumbers || []), orderNumber],
      currency: "CRC",
      crcTotal: totals.total,
      createdAt: now,
    },
    updatedAt: now,
  };
  if (order.total !== totals.total) {
    update.subtotal = totals.subtotal;
    update.shippingCost = totals.shippingCost;
    update.total = totals.total;
    update.priceCorrectedByServer = { previousTotal: order.total ?? null, at: now };
    update.itemsSummary = (order.itemsSummary || []).map((s) => {
      const l = totals.lines.find((x) => x.productId === s.productId && x.variantId === s.variantId);
      return l ? { ...s, price: l.unitPrice, lineTotal: l.lineTotal } : s;
    });
  }
  await ref.update(update);

  return { url, crcTotal: totals.total, currency: "CRC" };
});

// ----------------------------------------------
exports.tilopayConfirm = onCall({ ...OPTS, secrets: SECRETS }, async (request) => {
  const { orderId } = request.data || {};
  const { ref, order } = await loadOwnedOrder(request, orderId);
  if (order.paymentStatus === "pagado") return { result: "already_paid", message: "Este pedido ya fue pagado." };

  const saved = order.tilopay;
  if (!saved?.orderNumbers?.length) throw new HttpsError("failed-precondition", "Este pedido no tiene un pago Tilopay iniciado.");
  const cfg = await readConfig();
  const mode = saved.mode || cfg.mode;

  const token = await authToken();
  let last = { state: "not_found" };
  // Más reciente primero: el cliente pudo pagar un intento anterior.
  for (const orderNumber of [...saved.orderNumbers].reverse()) {
    const res = await tp.tpFetch("/api/v1/consult", { token, body: { key: TILOPAY_KEY.value(), orderNumber } });
    if (!res.ok) {
      console.error("[tilopay] consult falló:", res.status, JSON.stringify(res.data).slice(0, 300));
      throw new HttpsError("internal", "No se pudo consultar el pago en Tilopay.");
    }
    const r = tp.interpretConsult(res.data, { orderNumber, crcTotal: saved.crcTotal, mode });
    if (r.state === "approved" || r.state === "mismatch") { last = { ...r, orderNumber }; break; }
    if (r.state === "declined" && last.state === "not_found") last = { ...r, orderNumber };
  }

  const now = new Date().toISOString();
  if (last.state === "approved") {
    const tx = last.tx;
    const info = {
      ...saved, orderNumber: last.orderNumber, status: "approved",
      tilopayId: tx.id_tilopay ?? null, auth: tx.auth || "", card: tx.card || "", environment: tx.environment || "",
      commission: tx.commission ?? null, netToLiquidate: tx.net_to_liquidate ?? null, confirmedAt: now,
    };
    await db.runTransaction(async (t) => {
      const cur = await t.get(ref);
      if (cur.data().paymentStatus === "pagado") return;
      t.update(ref, {
        paymentMethod: "tilopay",
        paymentStatus: "pagado",
        status: "pagado", // dispara onOrderStatusChange (inventario, notificaciones, CRM)
        paymentAmount: cur.data().total,
        paymentTransactionId: String(tx.id_tilopay ?? tx.auth ?? ""),
        paymentDate: now,
        reconciliationResult: "tilopay_consult",
        reconciliationDetails: { method: "tilopay", orderNumber: last.orderNumber, auth: tx.auth || "", environment: tx.environment || "" },
        tilopay: info,
        updatedAt: now,
      });
    });
    return { result: "paid", message: "Pago con tarjeta recibido." };
  }

  if (last.state === "mismatch") {
    console.error("[tilopay] mismatch:", orderId, last.reason);
    await ref.update({
      paymentStatus: "verificando", status: "revision_manual",
      notes: `Tilopay: revisar manualmente. ${last.reason}`,
      tilopay: { ...saved, status: "mismatch", reason: last.reason, checkedAt: now }, updatedAt: now,
    });
    return { result: "review", message: "Tu pago está en revisión. Te avisaremos por WhatsApp." };
  }

  if (last.state === "declined") {
    await ref.update({ tilopay: { ...saved, status: "declined", checkedAt: now }, updatedAt: now });
    return { result: "declined", retry: true, message: "El banco no aprobó el pago. Puedes intentar con otra tarjeta." };
  }

  return { result: "not_found", retry: true, message: "No encontramos un pago completado. Si cancelaste, puedes intentarlo de nuevo." };
});
