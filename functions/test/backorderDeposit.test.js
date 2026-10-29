const test = require("node:test");
const assert = require("node:assert/strict");
const { computeBackorderDeposit } = require("../lib/backorderDeposit");

test("sin líneas bajo pedido no hay anticipo", () => {
  const r = computeBackorderDeposit([{ supplyType: "stock_propio", lineTotal: 10000 }], 12000);
  assert.deepEqual(r, { hasBackorder: false, depositTotal: 0, depositByLine: [0] });
});

test("anticipo = 20% del total completo (con envío y líneas en stock)", () => {
  const lines = [{ supplyType: "stock_propio", lineTotal: 30000 }, { supplyType: "bajo_pedido", lineTotal: 10000 }];
  const r = computeBackorderDeposit(lines, 45000); // 40000 + 5000 de envío
  assert.equal(r.hasBackorder, true);
  assert.equal(r.depositTotal, 9000);
  assert.deepEqual(r.depositByLine, [0, 9000]);
});

test("varias líneas bajo pedido: la suma por línea es exactamente el anticipo", () => {
  const lines = [
    { supplyType: "bajo_pedido", lineTotal: 33333 },
    { supplyType: "bajo_pedido", lineTotal: 33333 },
    { supplyType: "bajo_pedido", lineTotal: 33334 },
  ];
  const r = computeBackorderDeposit(lines, 101001);
  assert.equal(r.depositTotal, Math.round(101001 * 0.2));
  assert.equal(r.depositByLine.reduce((a, b) => a + b, 0), r.depositTotal);
});

test("coincide con la regla del checkout: Math.round(total * 0.2)", () => {
  for (const total of [1, 7, 12345, 99999, 250000]) {
    assert.equal(computeBackorderDeposit([{ supplyType: "bajo_pedido", lineTotal: total }], total).depositTotal, Math.round(total * 0.2));
  }
});
