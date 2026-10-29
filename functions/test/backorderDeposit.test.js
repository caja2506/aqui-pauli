const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { computeBackorder } = require("../lib/backorderDeposit");

const L = (supplyType, lineTotal) => ({ supplyType, lineTotal });

test("sin líneas bajo pedido: se paga todo y no hay saldo", () => {
  const r = computeBackorder([L("stock_propio", 10000)], 2000);
  assert.equal(r.hasBackorder, false);
  assert.equal(r.total, 12000);
  assert.equal(r.payNowTotal, 12000);
  assert.equal(r.depositTotal, 0);
  assert.equal(r.balanceDue, 0);
  assert.deepEqual(r.depositByLine, [0]);
});

test("solo bajo pedido: aparta 25% de las líneas; el saldo es 75%; envío se paga hoy", () => {
  const r = computeBackorder([L("bajo_pedido", 40000)], 3000);
  assert.equal(r.total, 43000);
  assert.equal(r.depositTotal, 10000);
  assert.equal(r.balanceDue, 30000);
  assert.equal(r.payNowTotal, 13000); // 10.000 de anticipo + 3.000 de envío
});

test("pedido mixto: stock y envío completos + 25% de lo bajo pedido", () => {
  const r = computeBackorder([L("stock_propio", 30000), L("bajo_pedido", 10000)], 5000);
  assert.equal(r.total, 45000);
  assert.equal(r.backorderSubtotal, 10000);
  assert.equal(r.depositTotal, 2500);
  assert.equal(r.balanceDue, 7500);
  assert.equal(r.payNowTotal, 37500);
  assert.equal(r.payNowTotal + r.balanceDue, r.total);
  assert.deepEqual(r.depositByLine, [0, 2500]);
});

test("varias líneas bajo pedido: la suma por línea es exactamente el anticipo", () => {
  const lines = [L("bajo_pedido", 33333), L("stock_propio", 1000), L("bajo_pedido", 33333), L("bajo_pedido", 33334)];
  const r = computeBackorder(lines, 0);
  assert.equal(r.depositTotal, Math.round(100000 * 0.25));
  assert.equal(r.depositByLine.reduce((a, b) => a + b, 0), r.depositTotal);
  assert.equal(r.depositByLine[1], 0);
});

test("paridad con el checkout web (src/utils/backorder.js)", async () => {
  const web = await import(pathToFileURL(path.join(__dirname, "../../src/utils/backorder.js")).href);
  const cases = [
    [[L("stock_propio", 10000)], 2000],
    [[L("bajo_pedido", 40000)], 3000],
    [[L("stock_propio", 30000), L("bajo_pedido", 10001)], 5000],
    [[L("bajo_pedido", 33333), L("bajo_pedido", 33333), L("bajo_pedido", 33334)], 1234],
  ];
  for (const [lines, shipping] of cases) {
    const s = computeBackorder(lines, shipping);
    const c = web.computeBackorder(lines, shipping);
    for (const k of ["hasBackorder", "total", "backorderSubtotal", "depositTotal", "balanceDue", "payNowTotal"]) {
      assert.equal(c[k], s[k], `${k} difiere para ${JSON.stringify(lines)}`);
    }
  }
  // el checkout calcula líneas con price*quantity
  assert.equal(web.computeBackorder([{ supplyType: "bajo_pedido", price: 20000, quantity: 2 }], 0).depositTotal, 10000);
});
