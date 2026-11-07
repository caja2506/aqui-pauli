"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSupplierCatalog, validateExternalUrl, extractProductOffers, lookupPrice, createPricingHandlers } = require('../lib/supplierPricing');

const fixture = () => ({ version: 1, supplier: 'LS', currency: 'CRC', sourceName: 'fixture.pdf', sourceDate: '2026-08-28', sourceSha256: 'a'.repeat(64),
  products: [{ id: 'ls-0001', description: 'Perfume de prueba 100 ml', cashCRC: 10000, cardCRC: 11000, page: 1 }] });
const html = data => '<html><script type="application/ld+json">' + JSON.stringify(data) + '</script></html>';
const offer = (price = '40.50', currency = 'USD') => ({ '@type': 'Offer', price, priceCurrency: currency });
const product = offers => ({ '@type': 'Product', name: 'Test perfume 100 ml', offers });
const pageResponse = body => new Response(body, { headers: { 'content-type': 'text/html' } });

test('importación conserva nombres, precios, duplicados descriptivos y discrepancias del PDF', () => {
  const input = fixture();
  input.products.push({ ...input.products[0], id: 'ls-0002', cardCRC: 9000 });
  const output = validateSupplierCatalog(input);
  assert.deepEqual(output.products, input.products);
  assert.equal(output.count, 2);
});
test('un catálogo corrupto se rechaza completo', () => {
  for (const value of [{ products: [] }, { currency: 'USD' }, { supplier: 'Other' }, { sourceSha256: 'wrong' }]) {
    assert.throws(() => validateSupplierCatalog({ ...fixture(), ...value }));
  }
  for (const row of [{ cashCRC: -1 }, { cardCRC: '11000' }, { description: '' }, { page: 0 }, { id: '../test' }]) {
    const input = fixture(); Object.assign(input.products[0], row); assert.throws(() => validateSupplierCatalog(input));
  }
  const input = fixture(); input.products.push(input.products[0]); assert.throws(() => validateSupplierCatalog(input));
});
test('solo enlaces HTTPS a tiendas aprobadas sin credenciales, puertos o hosts internos', () => {
  for (const url of ['http://www.jomashop.com/a', 'https://127.0.0.1/a', 'https://169.254.169.254/a', 'https://localhost/a', 'https://amazon.com.evil.test/a', 'https://user:secret@www.amazon.com/a', 'https://www.amazon.com:9000/a', 'https://www.amazon.com/', 'https://www.amazon.com/checkout']) {
    assert.throws(() => validateExternalUrl(url), url);
  }
  assert.equal(validateExternalUrl('https://www.jomashop.com/perfume.html?token=secret#test').href, 'https://www.jomashop.com/perfume.html');
});
test('extracción conserva moneda, variantes y precios exactos sin elegir automáticamente el más bajo', () => {
  const offers = extractProductOffers(html({ '@graph': [product([offer('40.50'), { ...offer('50.00'), name: '200 ml' }])] }));
  assert.equal(offers.length, 2); assert.equal(offers[0].amount, 40.5); assert.equal(offers[0].currency, 'USD');
  assert.match(offers[1].title, /200 ml/);
});
test('rangos, precios inválidos, cuotas, otra moneda o falta de existencia no son precio usable', () => {
  for (const entry of [{ '@type': 'AggregateOffer', lowPrice: 30, highPrice: 80, priceCurrency: 'USD' }, offer('1,200'), offer('NaN'), offer('0'), offer('10', 'EUR'), { ...offer(), availability: 'https://schema.org/OutOfStock' }, { '@type': 'UnitPriceSpecification', price: 10, priceCurrency: 'USD' }]) {
    assert.deepEqual(extractProductOffers(html(product(entry))), []);
  }
  assert.deepEqual(extractProductOffers('<script type="application/ld+json">broken</script>'), []);
});
test('Amazon devuelve entrada manual sin simular una conexión ni consultar la página', async () => {
  const result = await lookupPrice('https://www.amazon.com/dp/B000000000', () => { throw Error('unexpected request'); });
  assert.equal(result.status, 'manual_required'); assert.deepEqual(result.offers, []);
});
test('redirecciones externas o internas se rechazan antes de otra solicitud', async () => {
  let calls = 0;
  await assert.rejects(lookupPrice('https://www.jomashop.com/perfume.html', async () => { calls++; return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/metadata' } }); }));
  assert.equal(calls, 1);
});
test('bloqueo de tienda, rango o captcha requieren precio manual; lectura normal devuelve ofertas', async () => {
  const url = 'https://www.jomashop.com/perfume.html';
  assert.equal((await lookupPrice(url, async () => new Response('', { status: 403 }))).status, 'manual_required');
  assert.equal((await lookupPrice(url, async () => pageResponse('Verify you are human'))).status, 'manual_required');
  const result = await lookupPrice(url, async () => pageResponse(html(product(offer()))));
  assert.equal(result.status, 'found'); assert.equal(result.offers[0].amount, 40.5); assert.ok(result.checkedAt);
});

function database() {
  const values = new Map([['users_roles/admin', { role: 'admin' }], ['users_roles/customer', { role: 'cliente' }]]);
  const snapshot = key => ({ exists: values.has(key), data: () => values.get(key) });
  const db = { collection(name) { return { doc(id) { const key = `${name}/${id}`; return { key, get: async () => snapshot(key), set: async value => { values.set(key, value); } }; } }; },
    runTransaction: async callback => callback({ get: async ref => snapshot(ref.key), set: (ref, value) => values.set(ref.key, value) }) };
  return { db, values };
}
test('todos los callables exigen administrador antes de leer precios externos o guardar', async () => {
  const { db, values } = database();
  const handlers = createPricingHandlers({ db, fetchFn: () => { throw Error('unexpected fetch'); } });
  for (const handler of Object.values(handlers)) {
    for (const auth of [null, { uid: 'customer' }, { uid: 'unknown' }]) {
      await assert.rejects(handler({ auth, data: fixture() }), error => error.code === 'permission-denied');
    }
  }
  assert.equal(values.has('admin_supplier_catalogs/ls'), false);
});
test('importación del administrador es atómica y no escribe productos públicos', async () => {
  const { db, values } = database(); const handlers = createPricingHandlers({ db, now: () => 100000 });
  const result = await handlers.importSupplierCatalog({ auth: { uid: 'admin' }, data: fixture() });
  assert.equal(result.count, 1); assert.equal(values.get('admin_supplier_catalogs/ls').products.length, 1);
  const invalid = fixture(); invalid.products[0].cashCRC = -1;
  await assert.rejects(handlers.importSupplierCatalog({ auth: { uid: 'admin' }, data: invalid }));
  assert.equal(values.get('admin_supplier_catalogs/ls').products[0].cashCRC, 10000);
  assert.equal([...values.keys()].some(key => key.startsWith('products/')), false);
});
test('consulta externa limita frecuencia por administrador', async () => {
  const { db } = database(); const handlers = createPricingHandlers({ db, now: () => 100000, fetchFn: async () => pageResponse(html(product(offer()))) });
  const req = { auth: { uid: 'admin' }, data: { url: 'https://www.jomashop.com/perfume.html' } };
  assert.equal((await handlers.lookupExternalPrice(req)).status, 'found');
  await assert.rejects(handlers.lookupExternalPrice(req), error => error.code === 'resource-exhausted');
});
test('tipo de cambio de importación usa venta, no compra ni valores inventados', async () => {
  const { db } = database(); const req = { auth: { uid: 'admin' } };
  const handlers = createPricingHandlers({ db, fetchFn: async () => Response.json({ compra: { valor: 500 }, venta: { valor: 520, fecha: '2026-11-04' } }) });
  assert.equal((await handlers.getPricingExchangeRate(req)).rate, 520);
  await assert.rejects(createPricingHandlers({ db, fetchFn: async () => Response.json({ venta: { valor: 0 } }) }).getPricingExchangeRate(req));
});

const fragranceUrl = 'https://www.fragrancenet.com/cologne/example/product/eau-de-parfum';
function fragrancePage(items, acceptsCoupon = true) {
  const pageData = { currency: 'USD', acceptsCoupon, skuList: [{ SIZE: items }] };
  return pageResponse('<script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({ props: { pageProps: { pageData } } }) + '</script>');
}
const fragranceItem = { sku: '22', name: 'Perfume 100 ml', isOutOfStock: false, ourPrice: 155.99, discountPrice: 104.51 };

test('FragranceNet conserva SKU, precio regular y cupón solo para presentaciones disponibles', async () => {
  const lookup = async (items, coupon) => (await lookupPrice(fragranceUrl, async () => fragrancePage(items, coupon))).offers;
  const offers = await lookup([fragranceItem, { ...fragranceItem, sku: '23', isOutOfStock: true }], true);
  assert.deepEqual(offers.map(row => [row.id, row.amount]), [['22-regular', 155.99], ['22-coupon', 104.51]]);
  assert.match(offers[1].title, /100 ml.*Con cupón/);
  assert.equal((await lookup([fragranceItem], false)).length, 1);
  assert.equal((await lookup([{ ...fragranceItem, noDiscounts: true }], true)).length, 1);
});

test('rechazo temporal ofrece la observación del mismo producto con su fecha y caduca a las 24 horas', async () => {
  const { db } = database();
  let now = Date.UTC(2027, 0, 10);
  let status = 200;
  const handlers = createPricingHandlers({ db, now: () => now,
    fetchFn: async () => status === 200 ? fragrancePage([fragranceItem]) : new Response('', { status }) });
  const lookup = url => handlers.lookupExternalPrice({ auth: { uid: 'admin' }, data: { url } });
  assert.equal((await lookup(fragranceUrl)).status, 'found');
  const originalDate = new Date(now).toISOString();
  status = 403; now += 12000;
  const fallback = await lookup(fragranceUrl);
  assert.equal(fallback.status, 'reference');
  assert.equal(fallback.checkedAt, originalDate);
  assert.equal(fallback.offers[1].amount, 104.51);
  now += 12000;
  assert.equal((await lookup(fragranceUrl + '-other')).offers.length, 0);
  now = Date.parse(originalDate) + 86400000;
  assert.equal((await lookup(fragranceUrl)).offers.length, 0);
  now += 12000; status = 200; await lookup(fragranceUrl);
  now += 12000; status = 404; assert.equal((await lookup(fragranceUrl)).offers.length, 0);
  now += 12000; status = 403; assert.equal((await lookup(fragranceUrl)).offers.length, 0);
});
