"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeSnapshot, currentSnapshot, snapshotFingerprint, validateSnapshotAmounts, quoteFromSnapshot } = require("../lib/tilopayOrder");
const { parseMinorCRC, minorToCRC } = require("../lib/paymentMoney");
const { computeBackorder } = require("../lib/backorderDeposit");

function fixture(rows, shipping = 0, version = 2) {
  const lines = rows.map(([price, supplyType = "bajo_pedido", quantity = 1], index) => ({
    itemId: `item_${String(index).padStart(2, "0")}`, productId: `p${index}`, variantId: `v${index}`,
    quantity, price, lineTotal: minorToCRC(parseMinorCRC(price) * quantity), supplyType,
  }));
  const subtotalMinor = lines.reduce((sum, line) => sum + parseMinorCRC(line.lineTotal), 0);
  const totals = { subtotal: minorToCRC(subtotalMinor), shippingCost: shipping,
    total: minorToCRC(subtotalMinor + parseMinorCRC(shipping, { allowZero: true })) };
  const order = { uid: "u1", shippingType: "normal", shippingAddress: { canton: "Grecia" }, ...totals };
  const snapshot = makeSnapshot(order, lines, totals, { version });
  return { order, lines, totals, snapshot, amounts: validateSnapshotAmounts(snapshot), quote: quoteFromSnapshot(snapshot) };
}

test("stock paga todo, con cantidades, decimales y envío incluidos una sola vez", () => {
  const { amounts, quote } = fixture([[1234.56, "stock_propio", 3]], 200.25);
  assert.equal(amounts.totalMinor, 390393); assert.equal(amounts.amountMinor, 390393);
  assert.equal(amounts.remainingMinor, 0); assert.equal(amounts.depositMinor, 0);
  assert.equal(quote.crcTotal, 3903.93); assert.equal(quote.crcPayNow, 3903.93);
  assert.equal(quote.crcSubtotal, 3703.68); assert.equal(quote.crcShipping, 200.25);
  assert.equal(quote.hasBackorder, false);
});

test("solo Bajo pedido paga el 50% de mercadería más envío completo", () => {
  const { snapshot, quote } = fixture([[32000]], 3500);
  assert.equal(snapshot.totalMinor, 3550000); assert.equal(snapshot.amountMinor, 1950000);
  assert.equal(quote.crcPayNow, 19500); assert.equal(quote.crcBalanceDue, 16000);
  assert.equal(quote.crcDepositTotal, 16000); assert.equal(quote.crcBackorderSubtotal, 32000);
  assert.equal(snapshot.paymentPlan.depositPercent, 50);
});

test("decimales conservan centavos y mismo redondeo del apartado SINPE/PayPal", () => {
  const { snapshot, quote, amounts } = fixture([[10001.51], [50.25, "stock_propio"]], 100.99);
  assert.equal(quote.crcTotal, 10152.75); assert.equal(quote.crcPayNow, 5152.24);
  assert.equal(quote.crcBalanceDue, 5000.51); assert.equal(quote.crcDepositTotal, 5001);
  assert.equal(amounts.totalMinor, amounts.amountMinor + amounts.remainingMinor);
  const shared = computeBackorder(snapshot.lines, 100.99);
  assert.equal(quote.crcPayNow, shared.payNowTotal);
  assert.equal(quote.crcBalanceDue, shared.balanceDue);
  assert.equal(quote.crcDepositTotal, shared.depositTotal);
});

test("reparto acumulado evita restos negativos y suma exactamente el apartado", () => {
  for (const prices of [[1, 1, 1], [10001, 10001, 10001], [10001.11, 20000.22, 30000.33]]) {
    const { snapshot, amounts } = fixture(prices.map((price) => [price]));
    const shared = computeBackorder(snapshot.lines, 0);
    assert.deepEqual(amounts.depositByItem.map((line) => line.amountMinor / 100), shared.depositByLine);
    assert.equal(amounts.depositByItem.reduce((sum, line) => sum + line.amountMinor, 0), amounts.depositMinor);
    amounts.depositByItem.forEach((line, index) => {
      assert.ok(line.amountMinor >= 0); assert.ok(line.amountMinor <= snapshot.lines[index].lineTotalMinor);
    });
  }
});

test("importes pequeños incompatibles con el redondeo se rechazan sin plan inválido", () => {
  assert.throws(() => fixture([[0.01]]), /apartado válido/);
  assert.throws(() => fixture([[0.99]]), /apartado válido/);
  assert.throws(() => fixture([[0.8], [0.8]]), /distribuir/);
});

test("v1 histórico mantiene íntegros su importe y huella sin política de apartado", () => {
  const { snapshot, order, lines, amounts } = fixture([[32000]], 3500, 1);
  assert.equal(amounts.amountMinor, 3550000); assert.equal(amounts.remainingMinor, 0);
  assert.equal(snapshot.totalMinor, undefined); assert.equal(snapshot.paymentPlan, undefined);
  const current = currentSnapshot(order, lines.map((line) => ({ id: line.itemId, data: () => line })), snapshot);
  assert.equal(snapshotFingerprint(current), snapshotFingerprint(snapshot));
  assert.equal(current.version, 1);
});

test("reconstrucción v2 usa plan congelado y detecta cambios de líneas, total o dirección", () => {
  const { snapshot, order, lines } = fixture([[32000], [10000, "stock_propio"]]);
  const docs = lines.map((line) => ({ id: line.itemId, data: () => line }));
  assert.equal(snapshotFingerprint(currentSnapshot(order, docs, snapshot)), snapshotFingerprint(snapshot));
  assert.notEqual(snapshotFingerprint(currentSnapshot({ ...order, shippingAddress: { canton: "Alajuela" } }, docs, snapshot)),
    snapshotFingerprint(snapshot));
  assert.throws(() => currentSnapshot({ ...order, total: 1 }, docs, snapshot), /Totales/);
  const changed = docs.map((doc) => ({ ...doc, data: () => ({ ...doc.data(), supplyType: "stock_propio" }) }));
  assert.throws(() => currentSnapshot(order, changed, snapshot), /Plan de pago/);
});

test("validador rechaza manipulación del plan, centavos, reparto y versiones desconocidas", () => {
  const { snapshot } = fixture([[32000], [10000, "stock_propio"]]);
  const tamper = [
    (s) => { s.totalMinor = s.amountMinor; },
    (s) => { s.amountMinor++; },
    (s) => { s.paymentPlan.remainingMinor = 0; },
    (s) => { s.paymentPlan.depositMinor = 1; },
    (s) => { s.paymentPlan.depositPercent = 25; },
    (s) => { s.paymentPlan.version = 2; },
    (s) => { s.paymentPlan.hasBackorder = false; },
    (s) => { s.paymentPlan.depositByItem[0].amountMinor--; },
    (s) => { s.paymentPlan.depositByItem.reverse(); },
    (s) => { s.lines[0].unitPrice = 1; },
    (s) => { s.lines[0].lineTotalMinor++; },
    (s) => { s.lines[0].quantity = 0; },
    (s) => { s.subtotalMinor++; },
    (s) => { s.version = 3; },
  ];
  for (const mutate of tamper) { const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => validateSnapshotAmounts(copy)); }
});
