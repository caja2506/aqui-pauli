"use strict";
const { HttpsError } = require("firebase-functions/v2/https");
const { normalizeCode, activeSamples, containsPerfume } = require("./promotions.mjs");

const bad = "Ese código no es válido.";
function codeProblem(card, now) {
  if (!card || card.type !== "percent" || card.value !== 10 || card.appliesTo !== "products") return bad;
  if (card.used !== false) return "Ese código ya fue usado.";
  if (!(Date.parse(card.expiresAt) > now)) return "Ese código venció.";
  return null;
}

// Invalid attempts must commit even when a caller later rejects the checkout.
async function checkCode(db, uid, input) {
  if (!uid) throw new HttpsError("unauthenticated", "Iniciá sesión para aplicar un código.");
  const code = normalizeCode(input);
  const counter = db.collection("discountAttempts").doc(uid);
  return db.runTransaction(async tx => {
    const now = Date.now();
    const rate = (await tx.get(counter)).data();
    const inWindow = rate?.until > now;
    if (inWindow && rate.count >= 10) throw new HttpsError("resource-exhausted", "Alcanzaste el límite de intentos. Probá más tarde.");
    const card = code ? (await tx.get(db.collection("discountCodes").doc(code))).data() : null;
    const message = codeProblem(card, now);
    if (message) tx.set(counter, { count: inWindow ? rate.count + 1 : 1, until: inWindow ? rate.until : now + 3600000 });
    return { code, message };
  });
}

async function allowedCode(db, uid, input) {
  const result = await checkCode(db, uid, input);
  if (result.message) throw new HttpsError("failed-precondition", result.message);
  return result.code;
}

// Round the order discount once to whole colones. Allocate its centavos across
// products by cumulative proportions so all line totals reconcile exactly.
function discountedTotals(totals, code) {
  if (!code) return totals;
  const gross = totals.subtotalMinor;
  const amount = Number((BigInt(gross) + 500n) / 1000n);
  const cut = amount * 100;
  let cumulative = 0n, assigned = 0;
  const shares = new Map();
  const sorted = [...totals.lines].sort((a,b) => String(a.productId).localeCompare(String(b.productId), "en")
    || String(a.variantId).localeCompare(String(b.variantId), "en"));
  for (const line of sorted) {
    cumulative += BigInt(line.lineTotalMinor);
    const share = Number((2n * cumulative * BigInt(cut) + BigInt(gross)) / (2n * BigInt(gross)));
    const discountMinor = share - assigned;
    assigned = share;
    shares.set(line, discountMinor);
  }
  const lines = totals.lines.map(line => {
    const discountMinor = shares.get(line);
    const lineTotalMinor = line.lineTotalMinor - discountMinor;
    return { ...line, discountMinor, lineTotalMinor, lineTotal: lineTotalMinor / 100 };
  });
  return { ...totals, lines, subtotalBeforeDiscount: totals.subtotal, discount: { code, type: "percent", value: 10, amount },
    subtotalMinor: gross - cut, subtotal: (gross - cut) / 100,
    totalMinor: totals.totalMinor - cut, total: (totals.totalMinor - cut) / 100 };
}

async function reservationForCode(db, tx, code) {
  const ref = db.collection("discountCodes").doc(code);
  const problem = codeProblem((await tx.get(ref)).data(), Date.now());
  if (problem) throw new HttpsError("failed-precondition", problem);
  return ref;
}

async function reservedTotals(db, tx, orderId, order, gross) {
  if (!order.discount) return gross;
  const ref = db.collection("discountCodes").doc(order.discount.code);
  const card = (await (tx ? tx.get(ref) : ref.get())).data();
  if (!card?.used || card.code !== order.discount.code || card.orderId !== orderId || card.usedByUid !== (order.uid || order.customerUid) || order.discountReleasedAt) {
    throw new HttpsError("failed-precondition", "El código ya no está reservado para este pedido.");
  }
  const totals = discountedTotals(gross, card.code);
  if (totals.subtotalBeforeDiscount !== order.subtotalBeforeDiscount || totals.discount.amount !== order.discount.amount) {
    throw new HttpsError("failed-precondition", "El precio cambió. Revisá el pedido antes de pagar.");
  }
  return totals;
}

async function releaseCode(db, tx, orderId, order, now) {
  if (!order.discount || order.discountReleasedAt || order.fulfillment?.state === "applied"
      || ["pagado", "verificado", "parcial", "test_paid"].includes(order.paymentStatus)) return false;
  const ref = db.collection("discountCodes").doc(order.discount.code);
  const card = (await tx.get(ref)).data();
  if (!card?.used || card.orderId !== orderId || !(Date.parse(card.expiresAt) > Date.parse(now))) return false;
  tx.update(ref, { used: false, orderId: null, usedByUid: null, usedAt: null, releasedAt: now, releasedOrderId: orderId });
  return true;
}

async function giftForOrder(db, tx, items, choice) {
  const config = (await tx.get(db.collection("config").doc("decants"))).data();
  const options = activeSamples(config);
  if (!options.length) return null;
  const ids = [...new Set(items.map(line => line.productId))];
  const products = await Promise.all(ids.map(async id => (await tx.get(db.collection("products").doc(id))).data()));
  if (!await containsPerfume(products, async id => (await tx.get(db.collection("categories").doc(id))).data()?.parentId)) return null;
  const selected = options.find(o => o.id === choice);
  return { size: "3 ml", choice: selected?.id || "sorpresa", name: selected?.name || "Sorpresa", chosenByCustomer: !!selected };
}

module.exports = { checkCode, allowedCode, discountedTotals, reservationForCode, reservedTotals, releaseCode, giftForOrder };
