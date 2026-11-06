"use strict";
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { db } = require("./utils");
const { computeTotalsCRC, PricingError } = require("./lib/pricing");
const { checkCode, discountedTotals, providerDeclined } = require("./lib/discounts");
const { generateBatch, validateBatch } = require("./lib/cardBatches");
const { releaseCancelledReservation } = require("./lib/orderFulfillment");

const opts = { cors: true, invoker: "public" };
async function cartTotals(items, options) {
  try { return await computeTotalsCRC(db, items, undefined, options); }
  catch (error) {
    if (error instanceof PricingError) throw new HttpsError("failed-precondition", error.message);
    throw error;
  }
}

// Cotización pública de datos del catálogo. No crea pedidos ni reserva inventario.
exports.quoteCartDelivery = onCall({ ...opts, maxInstances: 10 }, async req => {
  const totals = await cartTotals(req.data?.items, { previewDelivery: true });
  return { subtotal: totals.subtotal, delivery: totals.delivery,
    lines: totals.lines.map(line => ({ price: line.unitPrice, supplyType: line.supplyType, productKind: line.productKind || "other", maxQuantity: line.maxQuantity })) };
});

exports.validateDiscountCode = onCall(opts, async req => {
  const { code, message } = await checkCode(db, req.auth?.uid, req.data?.code);
  if (message) return { ok: false, percent: 0, amount: 0, message };
  const totals = await cartTotals(req.data.items);
  return { ok: true, percent: 10, amount: discountedTotals(totals, code).discount.amount, message: "Código aplicado: −10%" };
});
exports.generateDiscountBatch = onCall(opts, async req => {
  if (!req.auth || (await db.collection("users_roles").doc(req.auth.uid).get()).data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Solo administradores pueden generar códigos.");
  }
  const args = { lote: req.data?.lote, n: req.data?.n, dias: 60 };
  try { validateBatch(args); } catch (e) { throw new HttpsError("invalid-argument", e.message); }
  try { const rows = await generateBatch(db, args); return { lote: args.lote, count: rows.length }; }
  catch (e) { if (e.message.startsWith("Ese lote")) throw new HttpsError("already-exists", e.message); throw e; }
});
// Independiente del trigger de correos y de la configuración SMTP.
exports.releaseOrderDiscount = onDocumentUpdated({ document: "orders/{orderId}", retry: true }, async event => {
  const before = event.data.before.data(), after = event.data.after.data();
  const terminal = ["cancelado", "expirado"].includes(after.status) || after.paymentStatus === "rechazado";
  if (after.discount && !after.discountReleasedAt && ((terminal && (before.status !== after.status || before.paymentStatus !== after.paymentStatus))
      || (providerDeclined(after) && !providerDeclined(before)))) {
    await releaseCancelledReservation({ db, orderId: event.params.orderId });
  }
});
