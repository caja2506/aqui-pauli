const test = require("node:test");
const assert = require("node:assert/strict");
const { computeTotalsCRC, shippingCostCRC, SHIPPING_INCLUDED } = require("../lib/pricing");

function fixture(overrides = {}) {
  const store = {
    "products/p1": { name: "Perfume real", active: true, basePrice: 80, images: ["https://images.example/product.jpg"] },
    "products/p1/variants/v1": { name: "50 ml", active: true, price: "12.34", supplyType: "stock_propio", stock: 20, reservedStock: 2 },
    ...overrides,
  };
  const direct = []; const transactional = [];
  const snap = (path) => ({ exists: store[path] !== undefined, data: () => store[path] });
  const ref = (path) => ({
    path,
    get: async () => { direct.push(path); return snap(path); },
    collection: (name) => ({ doc: (id) => ref(`${path}/${name}/${id}`) }),
  });
  return {
    db: { collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }) },
    transaction: { get: async (r) => { transactional.push(r.path); return snap(r.path); } },
    direct, transactional, store,
  };
}
const item = (extra = {}) => ({ productId: "p1", variantId: "v1", quantity: 3, ...extra });

test("precio y fulfillment canónicos: ignora precios, nombres, imágenes y abastecimiento del cliente", async () => {
  const f = fixture();
  const r = await computeTotalsCRC(f.db, [item({ price: 0.01, lineTotal: 0.03, name: "Falso", productName: "Falso", variantName: "Otro", imageUrl: "https://evil.example/x", supplyType: "bajo_pedido" })], { canton: "Grecia", shippingType: "express" });
  assert.equal(r.totalMinor, 3702);
  assert.equal(r.subtotal, 37.02);
  assert.equal(r.shippingCost, 0);
  assert.deepEqual(r.lines[0], {
    productId: "p1", variantId: "v1", quantity: 3,
    name: "Perfume real", productName: "Perfume real", variantName: "50 ml",
    imageUrl: "https://images.example/product.jpg", supplyType: "stock_propio",
    unitPrice: 12.34, lineTotal: 37.02, unitPriceMinor: 1234, lineTotalMinor: 3702,
  });
});

test("todas las lecturas usan la transacción suministrada", async () => {
  const f = fixture();
  await computeTotalsCRC(f.db, [item()], {}, { transaction: f.transaction });
  assert.deepEqual(f.direct, []);
  assert.deepEqual(f.transactional.sort(), ["products/p1", "products/p1/variants/v1"]);
});

test("envío incluido se conserva para cualquier zona y modalidad, sin leer tarifas", async () => {
  assert.equal(SHIPPING_INCLUDED, true);
  for (const canton of ["Grecia", "San José", "Puntarenas", ""]) {
    for (const type of ["normal", "express"]) assert.equal(shippingCostCRC({ normalOutside: 99999, expressGrecia: 5000 }, canton, type), 0);
  }
  const f = fixture();
  await computeTotalsCRC(f.db, [item()], { canton: "Puntarenas" });
  assert.ok(!f.direct.includes("config/shipping"));
});

test("rechaza IDs, cantidades y carritos inválidos antes de cualquier lectura", async () => {
  for (const items of [[], Array(51).fill(item()), [item({ productId: "x/y" })], [item({ variantId: "../v" })],
    [item({ productId: {} })], [item({ quantity: "3" })], [item({ quantity: 0 })], [item({ quantity: -2 })],
    [item({ quantity: 1.5 })], [item({ quantity: 100 })], [item({ quantity: Infinity })], [null]]) {
    const f = fixture();
    await assert.rejects(computeTotalsCRC(f.db, items, {}));
    assert.equal(f.direct.length, 0);
  }
});

test("rechaza variantes duplicadas, evitando subvalidar una reserva fragmentada", async () => {
  const f = fixture();
  await assert.rejects(computeTotalsCRC(f.db, [item(), item({ quantity: 1 })], {}), /duplicada/);
  assert.equal(f.direct.length, 0);
});

test("un precio ausente hereda catálogo base; cero o precio malformado nunca oculta un error", async () => {
  const f = fixture();
  delete f.store["products/p1/variants/v1"].price;
  assert.equal((await computeTotalsCRC(f.db, [item({ quantity: 1 })], {})).total, 80);
  for (const price of [0, -1, "", "1e3", "1,000.00", "12.345", NaN, Infinity]) {
    const g = fixture();
    g.store["products/p1/variants/v1"].price = price;
    if (price === "") {
      // Empty is the documented absence case, matching a blank catalog form.
      assert.equal((await computeTotalsCRC(g.db, [item({ quantity: 1 })], {})).total, 80);
    } else await assert.rejects(computeTotalsCRC(g.db, [item()], {}), /precio válido/);
  }
});

test("rechaza productos inexistentes, desactivados o eliminados", async () => {
  for (const mutate of [
    (s) => delete s["products/p1"], (s) => delete s["products/p1/variants/v1"],
    (s) => { s["products/p1"].active = false; }, (s) => { s["products/p1/variants/v1"].active = false; },
    (s) => { s["products/p1"].deleted = true; }, (s) => { s["products/p1/variants/v1"].deleted = true; },
  ]) {
    const f = fixture(); mutate(f.store);
    await assert.rejects(computeTotalsCRC(f.db, [item()], {}));
  }
});

test("stock corrupto o abastecimiento desconocido falla cerrado", async () => {
  for (const fields of [{ stock: -1 }, { reservedStock: -1 }, { stock: "20" }, { stock: 1.5 },
    { stock: 1, reservedStock: 2 }, { supplyType: "inventado" }]) {
    const f = fixture(); Object.assign(f.store["products/p1/variants/v1"], fields);
    await assert.rejects(computeTotalsCRC(f.db, [item()], {}));
  }
});

test("una cotización no consume stock ni descuenta de nuevo la reserva del pedido", async () => {
  const f = fixture();
  Object.assign(f.store["products/p1/variants/v1"], { stock: 3, reservedStock: 3 });
  const before = structuredClone(f.store);
  assert.equal((await computeTotalsCRC(f.db, [item()], {})).totalMinor, 3702);
  assert.deepEqual(f.store, before);
});

test("el total no puede desbordar el rango seguro de centavos", async () => {
  const f = fixture(); f.store["products/p1/variants/v1"].price = "90071992547409.91";
  await assert.rejects(computeTotalsCRC(f.db, [item({ quantity: 99 })], {}));
});

test("la variante define bajo pedido e imagen desde catálogo", async () => {
  const f = fixture(); Object.assign(f.store["products/p1/variants/v1"], { supplyType: "bajo_pedido", imageUrl: "https://images.example/variant.jpg" });
  const line = (await computeTotalsCRC(f.db, [item()], {})).lines[0];
  assert.equal(line.supplyType, "bajo_pedido");
  assert.equal(line.imageUrl, "https://images.example/variant.jpg");
});
