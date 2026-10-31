"use strict";

const crypto = require("node:crypto");
const { parseMinorCRC, minorToCRC } = require("./paymentMoney");
const { makePaymentPlan, validateSnapshotAmounts, quoteFromSnapshot } = require("./tilopayAmounts");

const PAYABLE_STATUSES = new Set(["pendiente_pago", "revision_manual"]);
const PAID_STATUSES = new Set(["pagado", "por_preparar", "enviado", "entregado"]);

function validDocumentId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function orderOwnerUid(order) {
  const a = typeof order?.uid === "string" && order.uid ? order.uid : null;
  const b = typeof order?.customerUid === "string" && order.customerUid ? order.customerUid : null;
  if ((a && b && a !== b) || (!a && !b)) throw new Error("Propietario del pedido inconsistente.");
  return a || b;
}

function isPaidOrder(order) {
  // For payment idempotency a received deposit is already settled. This does
  // not mean the remaining balance was paid or that fulfillment may ship it.
  return ["pagado", "verificado", "parcial"].includes(order?.paymentStatus) || PAID_STATUSES.has(order?.status);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function snapshotFingerprint(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(snapshot))).digest("hex");
}

function cleanText(value, max) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max) throw new Error("Datos de envío o contacto inválidos.");
  return value.trim();
}

function canonicalLine(line) {
  if (![line.itemId, line.productId, line.variantId].every(validDocumentId)) throw new Error("Identificador de item inválido.");
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) throw new Error("Cantidad inválida.");
  const unitPriceMinor = parseMinorCRC(line.unitPrice ?? line.price);
  const lineTotalMinor = unitPriceMinor * line.quantity;
  if (!Number.isSafeInteger(lineTotalMinor)) throw new Error("Importe de item fuera de rango.");
  if (line.lineTotal !== undefined && parseMinorCRC(line.lineTotal) !== lineTotalMinor) throw new Error("Importe de item inconsistente.");
  if (!["stock_propio", "bajo_pedido"].includes(line.supplyType)) throw new Error("Tipo de suministro inválido.");
  return {
    itemId: line.itemId, productId: line.productId, variantId: line.variantId,
    quantity: line.quantity, unitPrice: minorToCRC(unitPriceMinor), lineTotal: minorToCRC(lineTotalMinor),
    unitPriceMinor, lineTotalMinor, supplyType: line.supplyType,
    productName: cleanText(line.productName ?? line.name, 300),
    variantName: cleanText(line.variantName, 300), imageUrl: cleanText(line.imageUrl, 2048),
  };
}

function makeSnapshot(order, inputLines, totals, { version = 2, paymentPlan } = {}) {
  if (![1, 2].includes(version)) throw new Error("Versión de snapshot inválida.");
  if (!Array.isArray(inputLines) || inputLines.length < 1 || inputLines.length > 50) throw new Error("Items inválidos.");
  const lines = inputLines.map(canonicalLine).sort((a, b) => a.itemId.localeCompare(b.itemId));
  const identities = new Set(lines.map((line) => JSON.stringify([line.productId, line.variantId])));
  if (identities.size !== lines.length) throw new Error("Variantes duplicadas en el pedido.");
  const subtotalMinor = parseMinorCRC(totals.subtotal);
  const shippingMinor = parseMinorCRC(totals.shippingCost, { allowZero: true });
  const totalMinor = parseMinorCRC(totals.total);
  const sum = lines.reduce((value, line) => value + line.lineTotalMinor, 0);
  if (!Number.isSafeInteger(sum) || sum !== subtotalMinor || subtotalMinor + shippingMinor !== totalMinor) {
    throw new Error("Totales inconsistentes.");
  }
  if (!["normal", "express"].includes(order.shippingType)) throw new Error("Tipo de envío inválido.");
  const address = order.shippingAddress || {};
  const plan = version === 2 ? paymentPlan || makePaymentPlan(lines, totalMinor, shippingMinor) : null;
  const snapshot = {
    version, ownerUid: orderOwnerUid(order), currency: "CRC", amountMinor: plan ? plan.amountMinor : totalMinor, subtotalMinor, shippingMinor,
    shippingType: order.shippingType,
    shippingAddress: {
      provincia: cleanText(address.provincia, 100), canton: cleanText(address.canton, 100),
      distrito: cleanText(address.distrito, 100), codigoPostal: cleanText(address.codigoPostal, 20),
      señas: cleanText(address.señas, 1000),
    },
    customer: {
      name: cleanText(order.customerName, 300), email: cleanText(order.customerEmail, 254),
      phone: cleanText(order.customerPhone, 50),
    },
    lines,
  };
  if (version === 2) { snapshot.totalMinor = totalMinor; snapshot.paymentPlan = plan; }
  validateSnapshotAmounts(snapshot);
  return snapshot;
}

function currentSnapshot(order, itemDocs, originalSnapshot) {
  return makeSnapshot(order, itemDocs.map((doc) => ({ ...doc.data(), itemId: doc.id })), {
    subtotal: order.subtotal, shippingCost: order.shippingCost, total: order.total,
  }, originalSnapshot ? { version: originalSnapshot.version, paymentPlan: originalSnapshot.paymentPlan } : undefined);
}

function canonicalItem(line) {
  return {
    productId: line.productId, variantId: line.variantId, quantity: line.quantity,
    productName: line.productName, variantName: line.variantName, imageUrl: line.imageUrl,
    supplyType: line.supplyType, price: line.unitPrice, lineTotal: line.lineTotal,
  };
}

function attemptsOf(order) {
  const entries = order?.tilopay?.attemptsById;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return [];
  return Object.entries(entries).map(([key, value]) => ({ ...value, key }))
    .sort((a, b) => (Number(a.n) || 0) - (Number(b.n) || 0) || a.key.localeCompare(b.key));
}

function checkoutLockId(snapshot) {
  // A price/address change cannot silently create a second charge for the same cart.
  // A settled lock permits an intentional later purchase of the same products.
  const items = snapshot.lines.map((line) => [line.productId, line.variantId, line.quantity])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return snapshotFingerprint({ ownerUid: snapshot.ownerUid, items });
}

module.exports = {
  PAYABLE_STATUSES, validDocumentId, orderOwnerUid, isPaidOrder, snapshotFingerprint,
  makeSnapshot, currentSnapshot, canonicalItem, attemptsOf, checkoutLockId,
  validateSnapshotAmounts, snapshotAmounts: validateSnapshotAmounts, quoteFromSnapshot,
};
