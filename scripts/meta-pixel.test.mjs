import test from 'node:test';
import assert from 'node:assert/strict';
import { getCatalogId } from '../functions/lib/catalogId.mjs';
import { cartEvent, productEvent, isPurchase, trackPurchase, trackPageView, track } from '../src/utils/pixel.js';

const decant = 'decant-invictus-edt';
const id = 'DECANT-INVICTUS-EDT-5ML';
const items = [{ productId: decant, variantId: '5ml', price: 5300, quantity: 2 }];
const variant = async () => ({ id: '5ml', sku: id });
const order = { itemsSummary: items, total: 13100, paymentMethod: 'sinpe', paymentStatus: 'pendiente' };

test('coinciden los IDs de SKU, variante sin SKU, producto sin variantes y decant', async () => {
  const pid = '3X4skWr8m2P5IEeuKzwP', vid = 'AM0wRMNS3AOJz0Mza5b5';
  assert.equal(getCatalogId(pid, { id: vid }), `${pid}-${vid}`);
  assert.equal(getCatalogId('3nlBrbCDDrlKfmSU7unR', { sku: 123 }), '123');
  assert.equal(getCatalogId('6tG0W3Uj3PfrKUKftaMk'), '6tG0W3Uj3PfrKUKftaMk');
  const add = productEvent({ id: decant }, await variant(), 5300, 2);
  assert.equal(add.value, 10600);
  assert.deepEqual(await cartEvent(items, 10600, variant), { ...add, num_items: 2 });
  assert.deepEqual(add.contents, [{ id, quantity: 2, item_price: 5300 }]);
  assert.deepEqual(await cartEvent(items, 10600, async () => null), null);
});

test('Purchase exige captura real para pagos en línea y admite pedidos manuales registrados', () => {
  for (const paymentMethod of ['sinpe', 'sinpe_movil', 'transferencia', 'contra_entrega', 'whatsapp']) {
    assert.equal(isPurchase({ ...order, paymentMethod }), true);
  }
  const paypal = { ...order, paymentMethod: 'paypal', paymentStatus: 'parcial', paypal: { env: 'live', captureId: 'capture', captureStatus: 'COMPLETED' } };
  const tilopay = { ...order, paymentMethod: 'tilopay', paymentStatus: 'pagado', tilopay: { mode: 'live', status: 'approved' }, reconciliationDetails: { environment: 'Production' } };
  assert.equal(isPurchase(paypal), true);
  assert.equal(isPurchase(tilopay), true);
  for (const blocked of [ { ...paypal, paypal: { ...paypal.paypal, env: 'sandbox' } }, { ...paypal, paymentStatus: 'verificando' },
    { ...tilopay, reconciliationDetails: { environment: 'TEST' } }, { ...tilopay, tilopay: { mode: 'test', status: 'approved' } },
    { ...order, paymentStatus: 'test_paid' }, { ...order, status: 'cancelado' }, { ...order, isTest: true },
    { ...order, itemsSummary: [{ productId: 'zz-tilopay-live-check' }] },
    { ...order, itemsSummary: [{ productId: 'prueba-whatsapp-1' }] } ]) assert.equal(isPurchase(blocked), false);
});

test('un PageView por navegación, un Purchase por orden aun con llamadas concurrentes y recarga', async () => {
  const calls = [], marks = new Map();
  globalThis.window = { location: new URL('https://aquipauli.com/'), fbq: (...args) => calls.push(args), navigator: {},
    localStorage: { getItem: key => marks.get(key), setItem: (key, value) => marks.set(key, value) } };
  try {
    trackPageView('/'); trackPageView('/'); trackPageView('/catalogo'); trackPageView('/');
    assert.equal(calls.filter(c => c[0] === 'init').length, 1);
    assert.equal(calls.filter(c => c[1] === 'PageView').length, 3);
    assert.equal(window.fbq.disablePushState, true);
    await Promise.all([1, 2].map(() => trackPurchase('order-one', order, variant, () => true)));
    const receipt = calls.filter(c => c[1] === 'Purchase');
    assert.equal(receipt.length, 1);
    assert.equal(receipt[0][2].value, 13100);
    assert.deepEqual(receipt[0][3], { eventID: 'order-one' });
    assert.equal(marks.get('pixel_purchase_order-one'), '1');
    const fresh = await import('../src/utils/pixel.js?reload');
    await fresh.trackPurchase('order-one', order, variant, () => true);
    assert.equal(calls.filter(c => c[1] === 'Purchase').length, 1);
    delete window.fbq; assert.equal(track('Contact'), false);
  } finally { delete globalThis.window; }
});
