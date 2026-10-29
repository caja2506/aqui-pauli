// ==============================================
// AQUÍ PAULI — PayPal Checkout (Orders v2)
//
// Funciones (callables, us-central1):
//   paypalGetConfig    → clientId público + entorno (sandbox/live)
//   paypalGetQuote     → total en USD y tipo de cambio para mostrar antes de pagar
//   paypalCreateOrder  → crea la orden PayPal (monto calculado en servidor)
//   paypalCaptureOrder → captura y marca el pedido como pagado
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
const { db } = require("./utils");
const { getFxRate, crcToUsd } = require("./lib/fx");
const { computeTotalsCRC } = require("./lib/pricing");
const pp = require("./lib/paypalApi");

const PAYPAL_SECRET = defineSecret("PAYPAL_SECRET");
const PAYPAL_ENV = defineString("PAYPAL_ENV", { default: "sandbox" });
const PAYPAL_APP_CLIENT_ID = defineString("PAYPAL_APP_CLIENT_ID", { default: "" });

const OPTS = { cors: true, invoker: "public" };

const env = () => (PAYPAL_ENV.value() === "live" ? "live" : "sandbox");

async function authToken() {
  const clientId = PAYPAL_APP_CLIENT_ID.value();
  const secret = PAYPAL_SECRET.value();
  if (!clientId || !secret) throw new HttpsError("failed-precondition", "PayPal no está configurado.");
  try {
    return await pp.getAccessToken({ env: env(), clientId, secret });
  } catch (e) {
    console.error("[paypal] auth:", e.message);
    throw new HttpsError("unavailable", "No se pudo conectar con PayPal.");
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

/** Totales calculados en el servidor + conversión a USD. */
async function quoteFor(items, ship) {
  let totals;
  try {
    totals = await computeTotalsCRC(db, items, ship);
  } catch (e) {
    throw new HttpsError("failed-precondition", e.message);
  }
  let fx;
  try {
    fx = await getFxRate(db);
  } catch (e) {
    throw new HttpsError("unavailable", "No hay tipo de cambio disponible. Intenta más tarde.");
  }
  const usdTotal = crcToUsd(totals.total, fx.rate, fx.bufferPct);
  return {
    totals,
    fx,
    quote: {
      crcSubtotal: totals.subtotal,
      crcShipping: totals.shippingCost,
      crcTotal: totals.total,
      usdTotal,
      fxRate: fx.rate,
      fxSource: fx.source,
      fxDate: fx.date,
      fxBufferPct: fx.bufferPct,
      currency: "USD",
    },
  };
}

// ----------------------------------------------
exports.paypalGetConfig = onCall({ ...OPTS, secrets: [] }, async () => {
  let enabled = true;
  try {
    const s = await db.collection("config").doc("payments").get();
    if (s.exists && s.data().paypal?.enabled === false) enabled = false;
  } catch (e) {
    console.warn("[paypal] config/payments:", e.message);
  }
  const clientId = PAYPAL_APP_CLIENT_ID.value();
  return { enabled: enabled && !!clientId, env: env(), clientId, currency: "USD" };
});

// ----------------------------------------------
exports.paypalGetQuote = onCall({ ...OPTS, secrets: [] }, async (request) => {
  const { items, canton, shippingType } = request.data || {};
  if (!Array.isArray(items)) throw new HttpsError("invalid-argument", "items requerido.");
  const { quote } = await quoteFor(items, { canton, shippingType });
  return quote;
});

// ----------------------------------------------
exports.paypalCreateOrder = onCall({ ...OPTS, secrets: [PAYPAL_SECRET] }, async (request) => {
  const { orderId } = request.data || {};
  const { ref, order } = await loadOwnedOrder(request, orderId);

  if (order.paymentStatus === "pagado") {
    throw new HttpsError("failed-precondition", "Este pedido ya fue pagado.");
  }

  // Items y envío vienen del pedido guardado, pero los PRECIOS se recalculan.
  const itemsSnap = await ref.collection("items").get();
  const items = itemsSnap.docs.map((d) => d.data());
  const { totals, quote } = await quoteFor(items, {
    canton: order.shippingAddress?.canton,
    shippingType: order.shippingType,
  });

  const attempt = (order.paypal?.attempts || 0) + 1;
  const token = await authToken();
  const res = await pp.ppFetch("/v2/checkout/orders", {
    env: env(), token, method: "POST",
    requestId: `${orderId}-${attempt}`,
    body: pp.buildOrderPayload({ orderId, orderNumber: order.orderNumber, usdTotal: quote.usdTotal }),
  });
  if (!res.ok || !res.data.id) {
    console.error("[paypal] create order falló:", res.status, JSON.stringify(res.data).slice(0, 500));
    throw new HttpsError("internal", "PayPal no pudo crear la orden.");
  }

  const now = new Date().toISOString();
  const update = {
    paymentMethod: "paypal",
    paypal: {
      env: env(),
      orderId: res.data.id,
      status: res.data.status || "CREATED",
      attempts: attempt,
      ...quote,
      createdAt: now,
    },
    updatedAt: now,
  };
  // Si el cliente tenía precios/envío distintos a los del servidor, el servidor manda.
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

  return { paypalOrderId: res.data.id, ...quote };
});

// ----------------------------------------------
exports.paypalCaptureOrder = onCall({ ...OPTS, secrets: [PAYPAL_SECRET] }, async (request) => {
  const { orderId, paypalOrderId } = request.data || {};
  if (!paypalOrderId) throw new HttpsError("invalid-argument", "paypalOrderId requerido.");
  const { ref, order } = await loadOwnedOrder(request, orderId);

  if (order.paymentStatus === "pagado") {
    return { result: "already_paid", message: "Este pedido ya fue pagado." };
  }
  const saved = order.paypal;
  if (!saved || saved.orderId !== paypalOrderId) {
    throw new HttpsError("failed-precondition", "La orden PayPal no corresponde a este pedido.");
  }

  const token = await authToken();
  const e = env();

  // 1. Verificar la orden en PayPal contra lo guardado en el servidor
  const det = await pp.ppFetch(`/v2/checkout/orders/${paypalOrderId}`, { env: e, token });
  if (!det.ok) throw new HttpsError("internal", "No se pudo consultar la orden en PayPal.");
  const mismatch = pp.verifyOrderMatches(det.data, { orderId, usdTotal: saved.usdTotal });
  if (mismatch) {
    console.error("[paypal] mismatch:", orderId, mismatch);
    throw new HttpsError("failed-precondition", mismatch);
  }

  // 2. Capturar (si ya estaba capturada en PayPal, reusar el detalle)
  let ppOrder = det.data;
  if (ppOrder.status !== "COMPLETED") {
    if (ppOrder.status !== "APPROVED") {
      throw new HttpsError("failed-precondition", `El comprador aún no aprobó el pago (estado ${ppOrder.status}).`);
    }
    const cap = await pp.ppFetch(`/v2/checkout/orders/${paypalOrderId}/capture`, {
      env: e, token, method: "POST", requestId: `cap-${paypalOrderId}`, body: undefined,
    });
    const issue = cap.data?.details?.[0]?.issue;
    if (!cap.ok && issue === "INSTRUMENT_DECLINED") {
      return { result: "declined", retry: true, message: "PayPal rechazó el método de pago. Elige otro." };
    }
    if (!cap.ok && issue !== "ORDER_ALREADY_CAPTURED") {
      console.error("[paypal] capture falló:", cap.status, JSON.stringify(cap.data).slice(0, 500));
      throw new HttpsError("internal", "PayPal no pudo capturar el pago.");
    }
    ppOrder = cap.ok ? cap.data : (await pp.ppFetch(`/v2/checkout/orders/${paypalOrderId}`, { env: e, token })).data;
  }

  const outcome = pp.interpretCapture(ppOrder);
  const now = new Date().toISOString();
  const payer = ppOrder.payer || {};
  const paypalInfo = {
    ...saved,
    status: ppOrder.status,
    captureId: outcome.capture?.id || "",
    captureStatus: outcome.capture?.status || "",
    capturedUsd: Number(outcome.capture?.amount?.value || 0),
    payerId: payer.payer_id || "",
    payerEmail: payer.email_address || "",
    capturedAt: now,
  };

  if (outcome.state === "completed") {
    await db.runTransaction(async (t) => {
      const cur = await t.get(ref);
      if (cur.data().paymentStatus === "pagado") return;
      t.update(ref, {
        paymentMethod: "paypal",
        paymentStatus: "pagado",
        status: "pagado", // dispara onOrderStatusChange (inventario, Telegram, CRM)
        paymentAmount: cur.data().total,
        paymentTransactionId: paypalInfo.captureId,
        paymentDate: now,
        reconciliationResult: "paypal_captured",
        reconciliationDetails: { method: "paypal", env: e, paypalOrderId, captureId: paypalInfo.captureId },
        paypal: paypalInfo,
        updatedAt: now,
      });
    });
    return { result: "captured", message: "Pago PayPal recibido.", captureId: paypalInfo.captureId };
  }

  if (outcome.state === "pending") {
    await ref.update({
      paymentStatus: "verificando",
      status: "revision_manual",
      paymentTransactionId: paypalInfo.captureId,
      paypal: paypalInfo,
      notes: `PayPal pendiente: ${outcome.reason || "revisión"}`,
      updatedAt: now,
    });
    return { result: "pending", message: "PayPal dejó el pago en revisión. Te avisaremos." };
  }

  await ref.update({ paypal: paypalInfo, updatedAt: now });
  return { result: "declined", retry: true, message: "El pago no se completó." };
});
