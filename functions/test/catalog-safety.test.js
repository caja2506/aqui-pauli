const test = require('node:test');
const assert = require('node:assert/strict');
const { planProduct, secureCatalog } = require('../scripts/secure-catalog');
const { createMemoryFirestore } = require('./helpers/memoryFirestore');
const { computeTotalsCRC } = require('../lib/pricing');
const { availableQuantity } = require('../lib/catalogSafety.mjs');
const perfume = { active: true, productKind: 'perfume', basePrice: 25000 };
const variant = { id: 'v1', active: true, stock: 1, reservedStock: 0, price: 25000, supplyType: 'stock_propio', commercialStatus: 'disponible' };

test('precio de 100 o 1000 CRC no permite vender una colonia; decant de 1700 sí', async () => {
  for (const price of [0, 10, 100, 1000, '100', -100, NaN]) {
    const { db } = createMemoryFirestore({ 'products/p1': perfume, 'products/p1/variants/v1': { ...variant, price } });
    await assert.rejects(computeTotalsCRC(db, [{ productId: 'p1', variantId: 'v1', quantity: 1 }], {}), { reason: 'CATALOG_PRICE_INVALID' });
  }
  const { db } = createMemoryFirestore({ 'products/p1': { ...perfume, productKind: 'decant' }, 'products/p1/variants/v1': { ...variant, price: 1700 } });
  assert.equal((await computeTotalsCRC(db, [{ productId: 'p1', variantId: 'v1', quantity: 1 }], {}, { previewDelivery: true })).subtotal, 1700);
});

test('límite una por colonia incluye líneas con diferentes variantes y rechaza Bajo pedido', async () => {
  const { db } = createMemoryFirestore({ 'products/p1': perfume, 'products/p1/variants/v1': variant, 'products/p1/variants/v2': variant });
  for (const items of [[{ productId: 'p1', variantId: 'v1', quantity: 2 }],
    [{ productId: 'p1', variantId: 'v1', quantity: 1 }, { productId: 'p1', variantId: 'v2', quantity: 1 }]]) {
    await assert.rejects(computeTotalsCRC(db, items, {}), { reason: 'CATALOG_QUANTITY_LIMIT' });
  }
  await db.doc('products/p1/variants/v1').update({ supplyType: 'bajo_pedido' });
  await assert.rejects(computeTotalsCRC(db, [{ productId: 'p1', variantId: 'v1', quantity: 1 }], {}), { reason: 'CATALOG_UNAVAILABLE' });
});

test('agotado o reservado bloquea interfaz y cotización de carrito; conserva cotización de pedido ya reservado', async () => {
  for (const data of [{ ...variant, stock: 0 }, { ...variant, reservedStock: 1 }]) {
    assert.equal(availableQuantity(perfume, data), 0);
    const { db } = createMemoryFirestore({ 'products/p1': perfume, 'products/p1/variants/v1': data });
    const items = [{ productId: 'p1', variantId: 'v1', quantity: 1 }];
    await assert.rejects(computeTotalsCRC(db, items, {}, { previewDelivery: true }), { reason: 'CATALOG_UNAVAILABLE' });
    assert.equal((await computeTotalsCRC(db, items, {})).subtotal, 25000);
  }
});

test('migración baja 5 a 1, conserva cero y reservas; jamás inventa precio ni repone vendidos al reejecutar', async () => {
  const m = createMemoryFirestore({
    'products/p1': perfume, 'products/p1/variants/v1': { ...variant, stock: 5 },
    'products/p2': perfume, 'products/p2/variants/v1': { ...variant, stock: 0, supplyType: 'bajo_pedido' },
    'products/p3': perfume, 'products/p3/variants/v1': { ...variant, reservedStock: 1 },
    'products/prueba-paypal-10': { active: true, basePrice: 10 },
    'products/prueba-paypal-10/variants/unica': { ...variant, price: 10 },
  });
  const before = structuredClone(m.store);
  await secureCatalog({ db: m.db, onEvent: () => {} });
  assert.deepEqual(m.store, before);
  await secureCatalog({ db: m.db, apply: true, onEvent: () => {} });
  assert.equal(m.get('products/p1/variants/v1').stock, 1);
  assert.equal(m.get('products/p2/variants/v1').stock, 0);
  assert.equal(m.get('products/p2/variants/v1').supplyType, 'stock_propio');
  assert.equal(m.get('products/p3/variants/v1').reservedStock, 1);
  assert.equal(m.get('products/prueba-paypal-10').active, false);
  await m.db.doc('products/p1/variants/v1').update({ stock: 0 });
  await secureCatalog({ db: m.db, apply: true, onEvent: () => {} });
  assert.equal(m.get('products/p1/variants/v1').stock, 0);
  const verified = await secureCatalog({ db: m.db, onEvent: () => {} });
  assert.equal(verified.variantChanges + verified.productChanges, 0);
  assert.equal(m.get('products/p1/variants/v1').price, 25000);
});

test('reservas incompatibles se bloquean conservando su evidencia', () => {
  const plan = planProduct('p1', perfume, [{ ...variant, stock: 5, reservedStock: 3 }]);
  assert.deepEqual(plan.changes, [{ id: 'v1', patch: { active: false } }]);
});
