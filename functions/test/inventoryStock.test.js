"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeInventoryStock } = require("../lib/inventoryStock");

test("contadores válidos se conservan sin mutar catálogo ni emitir avisos", () => {
  const warnings = [];
  for (const data of [{ stock: 10, reservedStock: 2 }, { stock: 0, reservedStock: 0 },
    { stock: 3, reservedStock: 3 }, { stock: Number.MAX_SAFE_INTEGER, reservedStock: Number.MAX_SAFE_INTEGER }]) {
    const before = structuredClone(data);
    assert.deepEqual(normalizeInventoryStock(data, { onWarning: (event) => warnings.push(event) }), data);
    assert.deepEqual(data, before);
  }
  assert.deepEqual(warnings, []);
});

test("reservedStock legado negativo se vuelve cero; exceso se limita al stock físico", () => {
  const cases = [[-1, 0, "negative"], [-100, 0, "negative"], [6, 5, "above_stock"],
    [Number.MAX_SAFE_INTEGER + 1, 5, "above_stock"], [0.2, 1, "fractional"], [4.2, 5, "fractional"]];
  for (const [reservedStock, expected, reason] of cases) {
    const warnings = [];
    assert.deepEqual(normalizeInventoryStock({ stock: 5, reservedStock }, {
      context: "fulfillment", onWarning: (event) => warnings.push(event),
    }), { stock: 5, reservedStock: expected });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].context, "fulfillment");
    assert.ok(warnings[0].reasons.includes(reason));
    assert.equal(warnings[0].reservedStock, expected);
  }
});

test("stock ausente conserva el default cero; reservas ausentes o malformadas no rompen checkout", () => {
  for (const data of [{}, { stock: null }, { stock: 0, reservedStock: 4 }]) {
    assert.deepEqual(normalizeInventoryStock(data, { onWarning() {} }), { stock: 0, reservedStock: 0 });
  }
  for (const reservedStock of [undefined, null, "2", false, { count: 2 }, NaN, Infinity, -Infinity]) {
    assert.deepEqual(normalizeInventoryStock({ stock: 10, reservedStock }, { onWarning() {} }), { stock: 10, reservedStock: 0 });
  }
});

test("stock físico presente inválido sigue rechazado sin fabricar inventario", () => {
  for (const stock of [-1, -0.2, 1.5, "10", false, {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeInventoryStock({ stock, reservedStock: -1 }),
      (error) => error.code === "INVENTORY_STOCK_INVALID");
  }
});

test("aviso estructurado no expone identificadores, PII ni valores crudos del catálogo", () => {
  const warnings = [];
  const secret = "customer@example.test";
  normalizeInventoryStock({ stock: 3, reservedStock: { secret }, customerEmail: secret, productId: secret },
    { context: secret, onWarning: (event) => warnings.push(event) });
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], { severity: "WARNING", event: "inventory_reserved_stock_normalized",
    context: "inventory", reasons: ["non_numeric"], stock: 3, reservedStock: 0 });
  assert.ok(!JSON.stringify(warnings).includes(secret));
});

test("una falla del logger no convierte normalización tolerante en error de checkout", () => {
  assert.deepEqual(normalizeInventoryStock({ stock: 2, reservedStock: -1 }, {
    onWarning() { throw new Error("logging unavailable"); },
  }), { stock: 2, reservedStock: 0 });
});
