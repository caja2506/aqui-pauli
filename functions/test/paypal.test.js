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
  assert.equal(pp.verifyOrderMatches({ ...body, id: "PP1" }, { orderId: "o1", usdTotal: 22.15, paypalOrderId: "PP1" }), null);
  assert.ok(pp.verifyOrderMatches({ ...body, id: "PP2" }, { orderId: "o1", usdTotal: 22.15, paypalOrderId: "PP1" }));
});

test("interpretCapture", () => {
  const mk = (st, cst) => ({ status: st, purchase_units: [{ payments: { captures: [{ id: "c1", status: cst }] } }] });
  assert.equal(pp.interpretCapture(mk("COMPLETED", "COMPLETED")).state, "completed");
  assert.equal(pp.interpretCapture(mk("COMPLETED", "PENDING")).state, "pending");
  assert.equal(pp.interpretCapture(mk("COMPLETED", "DECLINED")).state, "declined");
  assert.equal(pp.interpretCapture({ status: "APPROVED" }).state, "other");
});

test("PayPal cotiza 50% Bajo pedido + stock y envío completos, igual que SINPE", async () => {
  const { paymentQuote } = require("../lib/paypalDeposit");
  const { computeBackorder } = await import("../../src/utils/backorder.js");
  const lines = [{ productId: "bag", variantId: "v1", quantity: 1, unitPrice: 32000, lineTotal: 32000, supplyType: "bajo_pedido" },
    { productId: "perfume", variantId: "v1", quantity: 1, unitPrice: 47000, lineTotal: 47000, supplyType: "stock_propio" }];
  const quote = paymentQuote({ lines, subtotal: 79000, shippingCost: 5000, total: 84000 }, { rate: 500, bufferPct: 0 });
  const client = computeBackorder(lines.map((line) => ({ ...line, price: line.unitPrice })), 5000);
  assert.equal(quote.crcTotal, 84000);
  assert.equal(quote.crcPayNow, 68000);
  assert.equal(quote.crcPayNow, client.payNowTotal);
  assert.equal(quote.crcBalanceDue, 16000);
  assert.equal(quote.crcBalanceDue, client.balanceDue);
  assert.equal(quote.usdTotal, 136);
  const payload = pp.buildOrderPayload({ orderId: "o1", usdTotal: quote.usdTotal, partial: true });
  assert.equal(payload.purchase_units[0].amount.value, "136.00");
  assert.match(payload.purchase_units[0].description, /Apartado 50%/);
});

test("PayPal conserva pago completo para stock y no cobra mínimos USD sobre un apartado CRC cero", () => {
  const { paymentQuote } = require("../lib/paypalDeposit");
  const stock = paymentQuote({ lines: [{ lineTotal: 32000, supplyType: "stock_propio" }], subtotal: 32000, shippingCost: 0, total: 32000 }, { rate: 500 });
  assert.equal(stock.crcPayNow, 32000);
  assert.equal(stock.crcBalanceDue, 0);
  assert.equal(stock.usdTotal, 64);
  assert.throws(() => paymentQuote({ lines: [{ lineTotal: 0.1, supplyType: "bajo_pedido" }], subtotal: 0.1, shippingCost: 0, total: 0.1 }, { rate: 500 }), /mayor que cero/);
});

test("PayPal exige coincidencia exacta de la cotización mostrada, incluso saldo, moneda y tipo de cambio", () => {
  const { paymentQuote, quoteMatches, quoteFromAttempt } = require("../lib/paypalDeposit");
  const quote = paymentQuote({ lines: [{ lineTotal: 32000, supplyType: "bajo_pedido" }], subtotal: 32000, shippingCost: 0, total: 32000 }, { rate: 500 });
  assert.equal(quoteMatches(quoteFromAttempt({ ...quote, orderId: "PP1" }), quote), true);
  for (const changed of [undefined, { ...quote, crcPayNow: 1 }, { ...quote, usdTotal: "32" },
    { ...quote, crcBalanceDue: 0 }, { ...quote, fxRate: 501 }, { ...quote, currency: "CRC" }, { ...quote, depositPercent: 1 }]) {
    assert.equal(quoteMatches(changed, quote), false);
  }
});

test("PayPal rechaza montos ausentes, NaN, infinitos y purchase_units adicionales", () => {
  const body = pp.buildOrderPayload({ orderId: "o1", usdTotal: 32 });
  for (const value of [undefined, "NaN", "Infinity", "", "0", "32.001", "3200", "32oops"]) {
    const order = structuredClone(body); order.purchase_units[0].amount.value = value;
    assert.ok(pp.verifyOrderMatches(order, { orderId: "o1", usdTotal: 32 }));
  }
  assert.ok(pp.verifyOrderMatches({ ...body, purchase_units: [...body.purchase_units, ...body.purchase_units] }, { orderId: "o1", usdTotal: 32 }));
});

test("PayPal comprueba moneda, monto e identidad de una única captura efectiva", () => {
  const order = pp.buildOrderPayload({ orderId: "o1", usdTotal: 32 });
  order.purchase_units[0].payments = { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "32.00" } }] };
  assert.equal(pp.verifyCaptureMatches(order, { usdTotal: 32 }), null);
  for (const patch of [{ amount: { currency_code: "CRC", value: "32.00" } }, { amount: { currency_code: "USD", value: "64.00" } },
    { id: "" }, { amount: { currency_code: "USD", value: "NaN" } }]) {
    const changed = structuredClone(order); Object.assign(changed.purchase_units[0].payments.captures[0], patch);
    assert.ok(pp.verifyCaptureMatches(changed, { usdTotal: 32 }));
  }
  order.purchase_units[0].payments.captures.push(order.purchase_units[0].payments.captures[0]);
  assert.ok(pp.verifyCaptureMatches(order, { usdTotal: 32 }));
});

test("PayPal POST pide representación completa y conserva idempotencia sin hacer solicitudes reales", async () => {
  let request;
  const result = await pp.ppFetch("/v2/checkout/orders/PP1/capture", { env: "sandbox", token: "fake", method: "POST", requestId: "cap-PP1",
    fetchFn: async (url, options) => { request = { url, options }; return { ok: true, status: 201, json: async () => ({ id: "PP1" }) }; } });
  assert.equal(result.ok, true);
  assert.equal(request.options.headers.Prefer, "return=representation");
  assert.equal(request.options.headers["PayPal-Request-Id"], "cap-PP1");
});
