// node --test functions/test
const test = require("node:test");
const assert = require("node:assert/strict");
const { crcToUsd, round2, getFxRate } = require("../lib/fx");
const { shippingCostCRC, computeTotalsCRC } = require("../lib/pricing");
const pp = require("../lib/paypalApi");

test("crcToUsd redondea a 2 decimales", () => {
  assert.equal(crcToUsd(45146, 451.46), 100);
  assert.equal(crcToUsd(10000, 451.46), 22.15);
  assert.equal(crcToUsd(1, 451.46), 0.01);
  assert.equal(crcToUsd(10000, 500, 5), 21);
  assert.equal(round2(1.005), 1.01);
  assert.throws(() => crcToUsd(100, 0));
});

test("envío: GAM, fuera, express Grecia", () => {
  // Envío incluido: siempre ₡0
  assert.equal(shippingCostCRC(null, "Grecia", "express"), 0);
  assert.equal(shippingCostCRC(null, "grecia", "normal"), 0);
  assert.equal(shippingCostCRC(null, "Upala", "normal"), 0);
  assert.equal(shippingCostCRC(null, "Upala", "express"), 0);
  assert.equal(shippingCostCRC({ normalOutside: 6000 }, "Upala"), 0);
});

// Firestore falso mínimo
function fakeDb(data) {
  const doc = (path) => ({
    async get() { const v = data[path]; return { exists: v !== undefined, data: () => v }; },
    async set(v) { data[path] = v; },
    collection: (c) => ({ doc: (id) => doc(`${path}/${c}/${id}`) }),
  });
  return { collection: (c) => ({ doc: (id) => doc(`${c}/${id}`) }) };
}

test("computeTotalsCRC usa precios de Firestore, no del cliente", async () => {
  const db = fakeDb({
    "products/p1": { name: "Eros", active: true, basePrice: 50000 },
    "products/p1/variants/v1": { price: 45000, active: true },
    "config/shipping": { normalGAM: 3000 },
  });
  const t = await computeTotalsCRC(db, [{ productId: "p1", variantId: "v1", quantity: 2, price: 1 }], { canton: "Grecia" });
  assert.equal(t.subtotal, 90000);
  assert.equal(t.shippingCost, 0);
  assert.equal(t.total, 90000);
  await assert.rejects(computeTotalsCRC(db, [{ productId: "p1", variantId: "v1", quantity: 0 }], {}));
  await assert.rejects(computeTotalsCRC(db, [{ productId: "x", variantId: "v1", quantity: 1 }], {}));
});

test("getFxRate: caché, fijo y fallback", async () => {
  const hacienda = async () => ({ ok: true, json: async () => ({ compra: { fecha: "2026-10-28", valor: 451.46 }, venta: { valor: 455.21 } }) });
  const db1 = fakeDb({});
  const r1 = await getFxRate(db1, { fetchFn: hacienda, now: 1000 });
  assert.equal(r1.rate, 451.46);
  // segunda llamada sale de caché (fetch que falla no se usa)
  const boom = async () => { throw new Error("no net"); };
  const r2 = await getFxRate(db1, { fetchFn: boom, now: 2000 });
  assert.equal(r2.rate, 451.46);
  assert.match(r2.source, /caché/);
  // caché vencida pero fetch cae → caché vieja
  const r3 = await getFxRate(db1, { fetchFn: boom, now: 1000 + 10 * 3600 * 1000 });
  assert.match(r3.source, /vieja/);
  // sin nada → error
  await assert.rejects(getFxRate(fakeDb({}), { fetchFn: boom }));
  // override fijo
  const r4 = await getFxRate(fakeDb({ "config/payments": { fx: { fixedRate: 500, bufferPct: 3 } } }), { fetchFn: boom });
  assert.deepEqual([r4.rate, r4.bufferPct], [500, 3]);
});

test("payload y verificación de orden PayPal", () => {
  const body = pp.buildOrderPayload({ orderId: "o1", orderNumber: "AP-1", usdTotal: 22.15 });
  assert.equal(body.purchase_units[0].amount.value, "22.15");
  assert.equal(body.purchase_units[0].custom_id, "o1");
  assert.equal(pp.verifyOrderMatches(body, { orderId: "o1", usdTotal: 22.15 }), null);
  assert.ok(pp.verifyOrderMatches(body, { orderId: "o2", usdTotal: 22.15 }));
  assert.ok(pp.verifyOrderMatches(body, { orderId: "o1", usdTotal: 22.16 }));
});

test("interpretCapture", () => {
  const mk = (st, cst) => ({ status: st, purchase_units: [{ payments: { captures: [{ id: "c1", status: cst }] } }] });
  assert.equal(pp.interpretCapture(mk("COMPLETED", "COMPLETED")).state, "completed");
  assert.equal(pp.interpretCapture(mk("COMPLETED", "PENDING")).state, "pending");
  assert.equal(pp.interpretCapture(mk("COMPLETED", "DECLINED")).state, "declined");
  assert.equal(pp.interpretCapture({ status: "APPROVED" }).state, "other");
});
