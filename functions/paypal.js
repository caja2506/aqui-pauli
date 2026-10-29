// ==============================================
// AQUÍ PAULI — PayPal Checkout (Orders v2)
//
// Funciones (callables, us-central1):
//   paypalGetConfig    → clientId público + entorno (sandbox/live)
//   paypalGetQuote     → total en USD y tipo de cambio para mostrar antes de pagar
//   paypalCreateOrder  → crea la orden PayPal (monto calculado en servidor)
//   paypalCaptureOrder → acredita el apartado o el pago completo verificado
//
// Los nombres NO usan "capturePaypalOrder" porque ya existe el legado
// `capturePayPalOrder` y los IDs de Cloud Functions gen2 no distinguen mayúsculas.
//
// Config:
//   PAYPAL_ENV            (param, functions/.env)  "sandbox" | "live"
//   PAYPAL_APP_CLIENT_ID  (param, functions/.env)  Client ID de la app PayPal (público)
//   PAYPAL_SECRET         (Firebase secret)        Secret de la app PayPal
//   Firestore config/payments → { paypal:{enabled}, fx:{fixedRate,bufferPct,...} }
// ==============================================

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { createHash } = require("node:crypto");
const { db } = require("./utils");
const { getFxRate } = require("./lib/fx");
const { computeTotalsCRC } = require("./lib/pricing");
const { computeBackorder } = require("./lib/backorderDeposit");
const { paymentQuote, quoteMatches, quoteFromAttempt, snapshotKey, initialPaymentReceived } = require("./lib/paypalDeposit");
const pp = require("./lib/paypalApi");
const { hasTilopay, isTerminalOrder, isPaidState, validDocumentId } = require("./lib/orderFulfillment");

const PAYPAL_SECRET = defineSecret("PAYPAL_SECRET");
const PAYPAL_ENV = defineString("PAYPAL_ENV", { default: "sandbox" });
const PAYPAL_APP_CLIENT_ID = defineString("PAYPAL_APP_CLIENT_ID", { default: "" });
const OPTS = { cors: true, invoker: "public" };
const env = () => (PAYPAL_ENV.value() === "live" ? "live" : "sandbox");

async function authToken() {
  const clientId = PAYPAL_APP_CLIENT_ID.value();
  const secret = PAYPAL_SECRET.value();
  if (!clientId || !secret) throw new HttpsError("failed-precondition", "PayPal no está configurado.");
  try { return await pp.getAccessToken({ env: env(), clientId, secret }); }
  catch (error) {
    console.error("[paypal] auth:", error.message);
    throw new HttpsError("unavailable", "No se pudo conectar con PayPal.");
  }
}

function assertPaypalOrder(order, uid, paypalOrderId) {
  if ((order.uid !== uid && order.customerUid !== uid) || (order.uid && order.customerUid && order.uid !== order.customerUid)) {
    throw new HttpsError("permission-denied", "No tienes acceso a este pedido.");
  }
  if (order.paymentMethod !== "paypal" || hasTilopay(order)) {
    throw new HttpsError("failed-precondition", "Este pedido no pertenece al flujo PayPal. Los intentos Tilopay se confirman exclusivamente con Tilopay.");
  }
  if (isTerminalOrder(order)) throw new HttpsError("failed-precondition", "El pedido está cerrado; el pago requiere conciliación.");
  if (paypalOrderId && order.paypal?.orderId !== paypalOrderId) {
    throw new HttpsError("failed-precondition", "La orden PayPal cambió; confirma el intento correcto.");
  }
}

async function loadOwnedOrder(request, orderId) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  if (!validDocumentId(orderId)) throw new HttpsError("invalid-argument", "orderId requerido.");
  const ref = db.collection("orders").doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
  const order = snap.data();
  assertPaypalOrder(order, request.auth.uid);
  return { ref, order };
}

async function fxRate() {
  try { return await getFxRate(db); }
  catch { throw new HttpsError("unavailable", "No hay tipo de cambio disponible. Intenta más tarde."); }
}

async function price(items, ship, transaction) {
  try { return await computeTotalsCRC(db, items, ship, { transaction }); }
  catch (error) { throw new HttpsError("failed-precondition", error.message); }
}

function assertDisplayedQuote(expected, quote) {
  if (!quoteMatches(expected, quote)) {
    throw new HttpsError("failed-precondition", "El monto o el tipo de cambio cambió. Revisá la cotización actualizada antes de pagar.", { quote });
  }
}

function assertAttempt(attempt) {
  // Los intentos anteriores cobraban el 100%. Nunca se capturan ni se sustituyen
  // automáticamente: la persona debe volver al checkout y aprobar el apartado.
  if (attempt?.schemaVersion !== 2 || !Array.isArray(attempt.snapshot?.lines) || !attempt.snapshot.lines.length
      || attempt.snapshot.lines.some((line) => !validDocumentId(line.itemId)) || !attempt.snapshotKey
      || attempt.snapshotKey !== snapshotKey(attempt.snapshot)
      || !quoteMatches(quoteFromAttempt(attempt), paymentQuote(attempt.snapshot, {
        rate: attempt.fxRate, bufferPct: attempt.fxBufferPct, source: attempt.fxSource, date: attempt.fxDate,
      }))) {
    throw new HttpsError("failed-precondition", "Este intento PayPal no usa el apartado vigente. Actualizá el checkout para crear un pedido nuevo; no se realizó ningún cobro.");
  }
  if (attempt.env !== env()) throw new HttpsError("failed-precondition", "El entorno PayPal del pedido cambió; requiere revisión.");
}

function assertReservation(order, lines) {
  const canonical = (values) => values.map((line) => [line.productId, line.variantId, line.quantity])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const stock = lines.filter((line) => line.supplyType === "stock_propio");
  const reservation = order.inventoryReservation;
  if (!stock.length && !reservation) return;
  if (reservation?.version !== 1 || reservation.state !== "reserved" || !Array.isArray(reservation.lines)
      || JSON.stringify(canonical(stock)) !== JSON.stringify(canonical(reservation.lines))) {
    throw new HttpsError("failed-precondition", "La disponibilidad o el abastecimiento cambió. Actualizá el checkout antes de pagar.");
  }
}

function paidResult(order) {
  // Los pedidos antiguos cobrados al 100% pueden conservar metadatos de apartado.
  // Su saldo histórico no vuelve a abrir una deuda que ya está pagada.
  const partial = order.paymentStatus === "parcial" || (!isPaidState(order)
    && order.paypal?.schemaVersion === 2 && order.paypal?.captureStatus === "COMPLETED"
    && Number(order.paypal.crcBalanceDue) > 0);
  return { result: "already_paid", message: partial ? "El apartado ya fue recibido; queda un saldo pendiente." : "Este pedido ya fue pagado.",
    partial, crcPayNow: order.paymentAmount || 0, crcBalanceDue: partial ? order.remainingTotal : 0,
    captureId: order.paypal?.captureId || order.paymentTransactionId || "" };
}

function canonicalItems(totals, itemDocs) {
  const backorder = computeBackorder(totals.lines, totals.shippingCost);
  return totals.lines.map((line, index) => {
    const doc = itemDocs.find((entry) => entry.data().productId === line.productId && entry.data().variantId === line.variantId);
    return { ref: doc.ref, value: {
      itemId: doc.id, productId: line.productId, variantId: line.variantId,
      productName: line.productName || line.name || "", variantName: line.variantName || "",
      imageUrl: line.imageUrl || "", price: line.unitPrice, quantity: line.quantity,
      subtotal: line.lineTotal, lineTotal: line.lineTotal, supplyType: line.supplyType,
      depositAmount: backorder.depositByLine[index], depositPaid: false, remainingPaid: false,
    } };
  });
}

exports.paypalGetConfig = onCall({ ...OPTS, secrets: [] }, async () => {
  let enabled = true;
  try {
    const snap = await db.collection("config").doc("payments").get();
    if (snap.exists && snap.data().paypal?.enabled === false) enabled = false;
  } catch (error) { console.warn("[paypal] config/payments:", error.message); }
  const clientId = PAYPAL_APP_CLIENT_ID.value();
  return { enabled: enabled && !!clientId, env: env(), clientId, currency: "USD" };
});

exports.paypalGetQuote = onCall({ ...OPTS, secrets: [] }, async (request) => {
  const { items, canton, shippingType } = request.data || {};
  if (!Array.isArray(items)) throw new HttpsError("invalid-argument", "items requerido.");
  const totals = await price(items, { canton, shippingType });
  return paymentQuote(totals, await fxRate());
});

exports.paypalCreateOrder = onCall({ ...OPTS, secrets: [PAYPAL_SECRET] }, async (request) => {
  const { orderId, expectedQuote } = request.data || {};
  const { ref, order: initial } = await loadOwnedOrder(request, orderId);
  if (initialPaymentReceived(initial) || isPaidState(initial)) {
    throw new HttpsError("failed-precondition", "El pago inicial de este pedido ya fue recibido.");
  }
  const fx = await fxRate();
  // Primero se fija un intento único en Firestore. Los reintentos/concurrencia
  // reutilizan el mismo request-id, el mismo monto y la misma orden PayPal.
  const attempt = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
    const order = snap.data();
    assertPaypalOrder(order, request.auth.uid);
    if (initialPaymentReceived(order) || isPaidState(order)) throw new HttpsError("failed-precondition", "El pago inicial de este pedido ya fue recibido.");
    if (order.paypal) {
      assertAttempt(order.paypal);
      assertDisplayedQuote(expectedQuote, quoteFromAttempt(order.paypal));
      assertReservation(order, order.paypal.snapshot.lines);
      // PayPal conserva la idempotencia por un tiempo limitado (6 h por defecto).
      // Un POST ambiguo antiguo no se vuelve a enviar como si aún fuera seguro.
      const createdAt = Date.parse(order.paypal.createdAt);
      if (!order.paypal.orderId && (!Number.isFinite(createdAt) || Date.now() - createdAt > 5 * 60 * 60 * 1000)) {
        throw new HttpsError("failed-precondition", "El intento PayPal pendiente venció y requiere revisión antes de reintentarlo.");
      }
      return order.paypal;
    }
    const itemSnap = await transaction.get(ref.collection("items"));
    const totals = await price(itemSnap.docs.map((doc) => doc.data()), {
      canton: order.shippingAddress?.canton, shippingType: order.shippingType,
    }, transaction);
    const quote = paymentQuote(totals, fx);
    assertDisplayedQuote(expectedQuote, quote);
    assertReservation(order, totals.lines);
    const items = canonicalItems(totals, itemSnap.docs);
    const now = new Date().toISOString();
    const snapshot = { ...totals, lines: totals.lines.map((line, index) => ({ ...line, itemId: items[index].value.itemId })) };
    const saved = { schemaVersion: 2, env: env(), orderId: "", status: "CREATING", attempts: 1,
      requestId: `paynow-${createHash("sha256").update(orderId).digest("hex").slice(0, 30)}`,
      ...quote, snapshot, snapshotKey: snapshotKey(snapshot), orderNumber: order.orderNumber || orderId, createdAt: now };
    transaction.update(ref, {
      paypal: saved, subtotal: totals.subtotal, shippingCost: totals.shippingCost, total: totals.total,
      hasBackorderItems: quote.hasBackorder, hasBackorder: quote.hasBackorder,
      backorderDeposit: quote.crcDepositTotal, depositTotal: quote.crcDepositTotal, remainingTotal: quote.crcBalanceDue,
      depositStatus: quote.hasBackorder ? "pendiente" : "no_aplica",
      remainingStatus: quote.hasBackorder ? "pendiente" : "no_aplica",
      backorderDepositPaid: false, backorderRemainingPaid: false,
      itemsSummary: items.map(({ value }) => value), updatedAt: now,
      ...(order.total !== totals.total ? { priceCorrectedByServer: { previousTotal: order.total ?? null, at: now } } : {}),
    });
    for (const item of items) transaction.set(item.ref, item.value);
    return saved;
  });
  const quote = quoteFromAttempt(attempt);
  if (attempt.orderId) return { paypalOrderId: attempt.orderId, ...quote };
  const token = await authToken();
  const res = await pp.ppFetch("/v2/checkout/orders", {
    env: attempt.env, token, method: "POST", requestId: attempt.requestId,
    body: pp.buildOrderPayload({ orderId, orderNumber: attempt.orderNumber, usdTotal: quote.usdTotal, partial: quote.crcBalanceDue > 0 }),
  });
  if (!res.ok || !res.data.id) {
    console.error("[paypal] create order falló:", res.status);
    throw new HttpsError("unavailable", "PayPal no pudo crear la orden. Reintentá para recuperar el mismo intento.");
  }
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
    const current = snap.data();
    assertPaypalOrder(current, request.auth.uid);
    if (initialPaymentReceived(current) || isPaidState(current)) throw new HttpsError("failed-precondition", "El pago inicial ya fue recibido.");
    if (current.paypal?.requestId !== attempt.requestId || current.paypal?.snapshotKey !== attempt.snapshotKey
        || (current.paypal.orderId && current.paypal.orderId !== res.data.id)) {
      throw new HttpsError("failed-precondition", "El intento de pago cambió; requiere revisión.");
    }
    transaction.update(ref, { paypal: { ...current.paypal, orderId: res.data.id, status: res.data.status || "CREATED" }, updatedAt: new Date().toISOString() });
  });
  return { paypalOrderId: res.data.id, ...quote };
});

exports.paypalCaptureOrder = onCall({ ...OPTS, secrets: [PAYPAL_SECRET] }, async (request) => {
  const { orderId, paypalOrderId } = request.data || {};
  if (typeof paypalOrderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(paypalOrderId)) throw new HttpsError("invalid-argument", "paypalOrderId requerido.");
  const { ref, order } = await loadOwnedOrder(request, orderId);
  if (initialPaymentReceived(order) || isPaidState(order)) return paidResult(order);
  assertPaypalOrder(order, request.auth.uid, paypalOrderId);
  const saved = order.paypal;
  assertAttempt(saved);
  const token = await authToken();
  const e = saved.env;
  const det = await pp.ppFetch(`/v2/checkout/orders/${paypalOrderId}`, { env: e, token });
  if (!det.ok) throw new HttpsError("unavailable", "No se pudo consultar la orden en PayPal.");
  const mismatch = pp.verifyOrderMatches(det.data, { orderId, usdTotal: saved.usdTotal, paypalOrderId });
  if (mismatch) throw new HttpsError("failed-precondition", mismatch);

  // La intención de captura queda persistida antes de llamar a PayPal. Reintentos
  // usan el mismo PayPal-Request-Id; una respuesta ambigua nunca habilita otro cobro.
  const alreadyPaid = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
    const current = snap.data();
    assertPaypalOrder(current, request.auth.uid, paypalOrderId);
    if (initialPaymentReceived(current) || isPaidState(current)) return paidResult(current);
    assertAttempt(current.paypal);
    assertReservation(current, saved.snapshot.lines);
    if (current.paypal.snapshotKey !== saved.snapshotKey || !quoteMatches(current.paypal, saved)) {
      throw new HttpsError("failed-precondition", "El importe del intento cambió; requiere revisión.");
    }
    transaction.update(ref, { "paypal.captureRequestedAt": current.paypal.captureRequestedAt || new Date().toISOString() });
    return null;
  });
  if (alreadyPaid) return alreadyPaid;

  let ppOrder = det.data;
  if (ppOrder.status !== "COMPLETED") {
    if (ppOrder.status !== "APPROVED") throw new HttpsError("failed-precondition", `El comprador aún no aprobó el pago (estado ${ppOrder.status}).`);
    const cap = await pp.ppFetch(`/v2/checkout/orders/${paypalOrderId}/capture`, {
      env: e, token, method: "POST", requestId: `cap-${paypalOrderId}`, body: undefined,
    });
    const issue = cap.data?.details?.[0]?.issue;
    if (!cap.ok && issue === "INSTRUMENT_DECLINED") return { result: "declined", retry: true, message: "PayPal rechazó el método de pago. Elige otro." };
    if (!cap.ok && issue !== "ORDER_ALREADY_CAPTURED") throw new HttpsError("unavailable", "No se pudo confirmar el pago. Reintentá para consultar el mismo cobro.");
    if (cap.ok) {
      ppOrder = cap.data;
      // PayPal puede responder con representación mínima aun tras el POST.
      // Solo acreditar después de consultar el importe realmente capturado.
      const unit = ppOrder.purchase_units?.[0];
      if (!unit?.payments?.captures || !unit.custom_id || !unit.amount?.currency_code || unit.amount.value == null) {
        const consulted = await pp.ppFetch(`/v2/checkout/orders/${paypalOrderId}`, { env: e, token });
        if (!consulted.ok) throw new HttpsError("unavailable", "No se pudo consultar el cobro existente.");
        ppOrder = consulted.data;
      }
    }
    else {
      const consulted = await pp.ppFetch(`/v2/checkout/orders/${paypalOrderId}`, { env: e, token });
      if (!consulted.ok) throw new HttpsError("unavailable", "No se pudo consultar el cobro existente.");
      ppOrder = consulted.data;
    }
  }
  const outcome = pp.interpretCapture(ppOrder);
  // Se valida también el dinero efectivamente capturado, no solo el monto de la orden.
  const captureMismatch = pp.verifyOrderMatches(ppOrder, { orderId, usdTotal: saved.usdTotal, paypalOrderId })
    || ((outcome.state === "completed" || outcome.state === "pending")
      ? pp.verifyCaptureMatches(ppOrder, { usdTotal: saved.usdTotal }) : null);
  if (captureMismatch) throw new HttpsError("failed-precondition", captureMismatch);

  const now = new Date().toISOString();
  const payer = ppOrder.payer || {};
  const paypalInfo = { ...saved, status: ppOrder.status, captureId: outcome.capture?.id || "",
    captureStatus: outcome.capture?.status || "", capturedUsd: Number(outcome.capture?.amount?.value || 0),
    payerId: payer.payer_id || "", payerEmail: payer.email_address || "", capturedAt: now };
  const partial = saved.crcBalanceDue > 0;
  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
    const current = snap.data();
    assertPaypalOrder(current, request.auth.uid, paypalOrderId);
    if (initialPaymentReceived(current) || isPaidState(current)) return paidResult(current);
    assertAttempt(current.paypal);
    if (current.paypal.snapshotKey !== saved.snapshotKey || !quoteMatches(current.paypal, saved)) {
      throw new HttpsError("failed-precondition", "El importe del intento cambió; requiere revisión.");
    }
    if (outcome.state === "completed") {
      const itemSnap = await transaction.get(ref.collection("items"));
      // Restaurar los importes y las líneas que se fijaron antes de la aprobación.
      // Ni precios posteriores del catálogo ni datos modificados en el cliente
      // pueden cambiar el dinero acreditado o los artículos a preparar.
      const itemDocs = saved.snapshot.lines.map((line) => ({ id: line.itemId,
        ref: ref.collection("items").doc(line.itemId), data: () => line }));
      const items = canonicalItems(saved.snapshot, itemDocs);
      for (const item of items) {
        item.value.depositPaid = item.value.supplyType === "bajo_pedido";
        item.value.remainingPaid = item.value.supplyType !== "bajo_pedido" || !partial;
      }
      transaction.update(ref, {
        paymentMethod: "paypal", paymentStatus: partial ? "parcial" : "pagado",
        status: partial ? "pendiente_pago" : "pagado",
        subtotal: saved.crcSubtotal, shippingCost: saved.crcShipping, total: saved.crcTotal,
        hasBackorder: saved.hasBackorder, hasBackorderItems: saved.hasBackorder,
        paymentAmount: saved.crcPayNow, remainingTotal: saved.crcBalanceDue,
        backorderDeposit: saved.crcDepositTotal, depositTotal: saved.crcDepositTotal,
        depositStatus: saved.hasBackorder ? "pagado" : "no_aplica",
        remainingStatus: partial ? "pendiente" : "no_aplica",
        backorderDepositPaid: saved.hasBackorder, backorderRemainingPaid: saved.hasBackorder && !partial,
        itemsSummary: items.map(({ value }) => value), paymentTransactionId: paypalInfo.captureId, paymentDate: now,
        reconciliationResult: partial ? "paypal_deposit_captured" : "paypal_captured",
        reconciliationDetails: { method: "paypal", env: e, paypalOrderId, captureId: paypalInfo.captureId,
          paidCRC: saved.crcPayNow, balanceDueCRC: saved.crcBalanceDue },
        paypal: { ...paypalInfo, captureRequestedAt: current.paypal.captureRequestedAt || now }, updatedAt: now,
      });
      for (const item of items) transaction.set(item.ref, item.value);
      const canonicalIds = new Set(items.map((item) => item.value.itemId));
      for (const doc of itemSnap.docs) if (!canonicalIds.has(doc.id)) transaction.delete(doc.ref);
      return { result: "captured", message: partial ? "Apartado recibido con PayPal; queda un saldo pendiente." : "Pago PayPal recibido.",
        captureId: paypalInfo.captureId, partial, crcPayNow: saved.crcPayNow, crcBalanceDue: saved.crcBalanceDue };
    }
    if (outcome.state === "pending") {
      transaction.update(ref, { paymentStatus: "verificando", status: "revision_manual",
        paymentTransactionId: paypalInfo.captureId, paypal: paypalInfo,
        notes: `PayPal pendiente: ${outcome.reason || "revisión"}`, updatedAt: now });
      return { result: "pending", message: "PayPal dejó el pago en revisión. Te avisaremos." };
    }
    transaction.update(ref, { paypal: paypalInfo, updatedAt: now });
    return { result: "declined", retry: true, message: "El pago no se completó." };
  });
  return result;
});
