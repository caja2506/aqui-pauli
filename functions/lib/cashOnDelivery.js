"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const fulfillment = require("./orderFulfillment");
const { minorToCRC } = require("./paymentMoney");

const OPEN_STATUSES = new Set(["pendiente_pago", "por_preparar", "preparando", "enviado", "entregado"]);
const fail = (message) => { throw new HttpsError("failed-precondition", message); };
const moneyEquals = (value, expected) => {
  try { return fulfillment.moneyMinor(value) === expected; } catch { return false; }
};
const identity = (lines) => JSON.stringify(lines.map(({ productId, variantId, quantity }) =>
  [productId, variantId, quantity]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

function totals(order) {
  if (![order.total, order.subtotal, order.shippingCost].every(value => typeof value === "number" && Number.isFinite(value))) {
    fail("El total guardado del pedido es inválido.");
  }
  const total = fulfillment.moneyMinor(order.total);
  const subtotal = fulfillment.moneyMinor(order.subtotal);
  const shipping = fulfillment.moneyMinor(order.shippingCost);
  if (total <= 0 || total !== subtotal + shipping) fail("El total guardado del pedido es inconsistente.");
  return { total, subtotal, shipping };
}

function response(orderId, action, order, alreadyApplied) {
  return { success: true, orderId, action, status: order.status, paymentStatus: order.paymentStatus,
    total: order.total, remainingTotal: order.remainingTotal, alreadyApplied };
}

// Cobro de efectivo y cancelación son operaciones administrativas explícitas.
// Inventario, pago y CRM se confirman juntos; no dependen del trigger ni envían avisos.
async function manageCashOnDeliveryOrder({ db, request, crmDefaults = {} }) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Debés iniciar sesión.");
  const { orderId, action } = request.data || {};
  if (!fulfillment.validDocumentId(orderId) || !["confirm_payment", "cancel"].includes(action)) {
    throw new HttpsError("invalid-argument", "Pedido o acción contra entrega inválidos.");
  }

  return db.runTransaction(async (transaction) => {
    const role = await transaction.get(db.collection("users_roles").doc(request.auth.uid));
    if (!role.exists || role.data().role !== "admin") {
      throw new HttpsError("permission-denied", "Solo administradores pueden gestionar el cobro contra entrega.");
    }
    const ref = db.collection("orders").doc(orderId);
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
    const order = snap.data();
    if (order.paymentMethod !== "contra_entrega" || order.cashOnDelivery?.version !== 1
        || fulfillment.hasTilopay(order) || Object.prototype.hasOwnProperty.call(order, "paypal")) {
      fail("Este pedido no usa el flujo de contra entrega.");
    }

    let amounts;
    try { amounts = totals(order); } catch (error) {
      if (error instanceof HttpsError) throw error;
      fail("El pedido tiene importes inválidos; requiere revisión.");
    }
    // Reintentos de la misma acción no consumen stock ni cuentan la compra otra vez.
    if (action === "cancel" && order.status === "cancelado" && order.cashOnDelivery.state === "cancelled"
        && order.inventoryReservation?.state === "released" && order.paymentStatus === "pendiente"
        && order.paymentAmount === 0 && order.remainingTotal === 0) {
      return response(orderId, action, order, true);
    }
    if (!OPEN_STATUSES.has(order.status)) fail("El pedido está cerrado o requiere revisión; no admite esta acción.");
    if (action === "confirm_payment" && order.cashOnDelivery.state === "collected"
        && order.paymentStatus === "pagado" && moneyEquals(order.paymentAmount, amounts.total)
        && order.remainingTotal === 0 && order.inventoryReservation?.state === "consumed"
        && order.fulfillment?.state === "applied") {
      return response(orderId, action, order, true);
    }
    if (order.cashOnDelivery.state !== "pending" || order.paymentStatus !== "pendiente" || order.paymentAmount !== 0
        || order.inventoryReservation?.version !== 1 || order.inventoryReservation.state !== "reserved"
        || order.fulfillment || !moneyEquals(order.remainingTotal, amounts.total)) {
      fail("El pedido ya fue cobrado o su reserva requiere revisión.");
    }
    if (action === "cancel" && order.status === "entregado") {
      fail("Un pedido ya entregado no se cancela por esta acción. Revisá primero la devolución del producto.");
    }

    const itemSnap = await transaction.get(ref.collection("items"));
    let lines; let reserved;
    try {
      const raw = itemSnap.docs.map(doc => doc.data());
      if (raw.some(line => line.supplyType !== "stock_propio")) throw new Error("Hay productos sin stock propio");
      lines = fulfillment.normalizeLines(raw.map(line => ({ ...line, unitPrice: line.price })), { priced: true });
      reserved = fulfillment.normalizeLines(order.inventoryReservation.lines);
      if (identity(lines) !== identity(reserved)) throw new Error("La reserva no coincide con los productos");
      const subtotal = lines.reduce((sum, line) => sum + fulfillment.moneyMinor(line.lineTotal), 0);
      if (!Number.isSafeInteger(subtotal) || subtotal !== amounts.subtotal) throw new Error("El subtotal no coincide");
    } catch { fail("Los productos o la reserva guardados son inconsistentes; requiere revisión."); }

    const variants = [];
    for (const line of lines) {
      const variantRef = db.collection("products").doc(line.productId).collection("variants").doc(line.variantId);
      const variantSnap = await transaction.get(variantRef);
      if (!variantSnap.exists) fail("Falta una variante reservada; requiere revisión de inventario.");
      let stock;
      try { stock = fulfillment.checkedStock(variantSnap.data()); }
      catch { fail("El inventario de una variante requiere revisión."); }
      if (stock.reservedStock < line.quantity || stock.stock < line.quantity) {
        fail("La reserva o el stock físico son insuficientes; no se aplicó ningún cobro.");
      }
      variants.push({ ref: variantRef, line, ...stock });
    }

    let crmRef; let crmSnap; let interactionRef;
    if (action === "confirm_payment") {
      const owner = order.customerUid || order.uid;
      if (!fulfillment.validDocumentId(owner) || (order.uid && order.customerUid && order.uid !== order.customerUid)) {
        fail("El propietario del pedido requiere revisión.");
      }
      crmRef = db.collection("crm_contacts").doc(owner);
      crmSnap = await transaction.get(crmRef);
      interactionRef = crmRef.collection("interactions").doc(`order_${orderId}_paid`);
      const priorInteraction = await transaction.get(interactionRef);
      if (priorInteraction.exists) fail("El CRM ya registró este cobro; requiere revisión antes de repetirlo.");
    }

    const now = new Date().toISOString();
    let update;
    let crmData;
    if (action === "confirm_payment") {
      const old = crmSnap.exists ? crmSnap.data() : {};
      const count = (Number.isSafeInteger(old.totalOrders) && old.totalOrders >= 0 ? old.totalOrders : 0) + 1;
      let spent;
      try {
        const oldSpent = typeof old.totalSpent === "number" && Number.isFinite(old.totalSpent) && old.totalSpent >= 0
          ? fulfillment.moneyMinor(old.totalSpent) : 0;
        spent = minorToCRC(oldSpent + amounts.total);
      } catch { fail("Los acumulados del CRM requieren revisión; no se aplicó ningún cobro."); }
      if (!Number.isSafeInteger(count)) fail("El contador del CRM requiere revisión.");
      crmData = { ...(crmSnap.exists ? {} : crmDefaults), uid: order.customerUid || order.uid,
        email: old.email || order.customerEmail || "", displayName: old.displayName || order.customerName || "",
        phone: old.phone || order.customerPhone || "", totalOrders: count, totalSpent: spent,
        funnelStage: count >= 2 ? "recurrente" : "comprador",
        sourceChannels: [...new Set([...(Array.isArray(old.sourceChannels) ? old.sourceChannels : []), "web"])],
        lastOrderDate: now, lastInteractionAt: now, updatedAt: now,
        ...(!crmSnap.exists ? { source: "compra", createdAt: now } : {}) };
      update = {
        status: order.status === "pendiente_pago" ? "por_preparar" : order.status,
        paymentStatus: "pagado", paymentAmount: order.total, paymentDate: now, remainingTotal: 0,
        reconciliationResult: "cash_on_delivery_collected",
        reconciliationDetails: { approvedBy: request.auth.uid, approvedAt: now },
        cashOnDelivery: { ...order.cashOnDelivery, state: "collected", collectedBy: request.auth.uid, collectedAt: now },
        inventoryReservation: { ...order.inventoryReservation, state: "consumed", consumedAt: now },
        fulfillment: { version: 1, state: "applied", inventoryAppliedAt: now, crmAppliedAt: now, paymentTransactionId: "" },
        updatedAt: now,
      };
    } else {
      update = { status: "cancelado", paymentStatus: "pendiente", paymentAmount: 0, remainingTotal: 0,
        cashOnDelivery: { ...order.cashOnDelivery, state: "cancelled", cancelledBy: request.auth.uid, cancelledAt: now },
        inventoryReservation: { ...order.inventoryReservation, state: "released", releasedAt: now }, updatedAt: now };
    }

    // No hay escrituras antes de terminar todas las lecturas y validaciones.
    for (const variant of variants) transaction.update(variant.ref, {
      reservedStock: variant.reservedStock - variant.line.quantity,
      ...(action === "confirm_payment" ? { stock: variant.stock - variant.line.quantity } : {}),
    });
    if (action === "confirm_payment") {
      transaction.set(crmRef, crmData, { merge: true });
      transaction.set(interactionRef, { type: "compra", channel: "web", orderId, amount: order.total, createdAt: now,
        description: `Pedido ${order.orderNumber || orderId} cobrado contra entrega — ₡${order.total}`,
        metadata: { orderNumber: order.orderNumber || orderId, paymentMethod: "contra_entrega", hasBackorderItems: false,
          approvedBy: request.auth.uid } });
    }
    transaction.update(ref, update);
    return response(orderId, action, { ...order, ...update }, false);
  });
}

module.exports = { manageCashOnDeliveryOrder };
