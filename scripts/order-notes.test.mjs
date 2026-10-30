// Exercise the real manual-order and PayPal client services with isolated SDK
// boundaries. No Firestore, callable, email or payment request leaves the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithEsbuild } from 'vite';
import { MAX_CUSTOMER_NOTES_LENGTH, normalizeCustomerNotes } from '../functions/lib/customerNotes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const MANUAL = 'src/services/orderService.js';
const PAYPAL = 'src/services/payments/paypalClient.js';
const abs = relative => path.join(root, relative);
const files = [MANUAL, PAYPAL, 'src/utils/backorder.js', 'src/utils/formatters.js', 'functions/lib/customerNotes.mjs'];
const compiled = new Map(await Promise.all(files.map(async relative => {
  const filename = abs(relative);
  const { code } = await transformWithEsbuild(await readFile(filename, 'utf8'), filename, {
    loader: 'js', format: 'cjs', target: 'es2022', sourcemap: false,
  });
  return [filename, code];
})));

const orderFixture = (extra = {}) => ({
  uid: 'customer-1', customerName: 'Ana Prueba', customerEmail: 'ana@example.invalid', customerPhone: '88887777',
  customerCedula: '', paymentMethod: 'sinpe', paymentPhone: '88887777',
  shippingAddress: { provincia: 'Alajuela', canton: 'Grecia', distrito: 'Grecia', codigoPostal: '20301', señas: 'Recepción' },
  shippingType: 'normal', subtotal: 104000, shippingCost: 0,
  items: [
    { productId: 'stock', variantId: 'v1', productName: 'Perfume disponible', variantName: '100 ml', price: 40000, quantity: 1, supplyType: 'stock_propio' },
    { productId: 'backorder', variantId: 'v2', productName: 'Tenis', variantName: 'Rojo 34', price: 32000, quantity: 2, supplyType: 'bajo_pedido' },
  ],
  ...extra,
});

function loadServices() {
  const effects = { reads: 0, refs: 0, batches: 0, commits: 0, callables: [] };
  const writes = [];
  const store = new Map();
  const forbidden = name => () => { throw new Error(`Unexpected external operation: ${name}`); };
  const firebase = { db: { fixture: 'firestore' }, functions: { fixture: 'functions' } };
  const firestore = {
    collection(_db, ...segments) { effects.refs++; return { path: segments.join('/'), kind: 'collection' }; },
    doc(first, ...segments) {
      effects.refs++;
      const refPath = first?.kind === 'collection' ? `${first.path}/local-order` : segments.join('/');
      return { path: refPath, id: refPath.split('/').at(-1) };
    },
    writeBatch(db) {
      assert.equal(db, firebase.db);
      effects.batches++;
      const staged = [];
      return {
        set(ref, value, options) { staged.push({ path: ref.path, value: structuredClone(value), options }); },
        async commit() {
          effects.commits++;
          for (const entry of staged) { writes.push(entry); store.set(entry.path, entry.value); }
        },
      };
    },
    ...Object.fromEntries(['setDoc', 'updateDoc', 'serverTimestamp', 'getDocs'].map(name => [name, forbidden(name)])),
  };
  const modules = new Map([
    [abs('src/firebase.js'), firebase],
    ['firebase/firestore', firestore],
    ['firebase/functions', { httpsCallable(functions, name) {
      assert.equal(functions, firebase.functions);
      return async data => {
        effects.callables.push({ name, data: structuredClone(data) });
        return { data: { orderId: 'server-order', orderNumber: 'AP-TEST' } };
      };
    } }],
  ]);
  const cache = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    assert.ok(compiled.has(filename), `Unresolved real service: ${path.relative(root, filename)}`);
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = name => {
      if (modules.has(name)) return modules.get(name);
      assert.ok(name.startsWith('.'), `Unexpected external import: ${name}`);
      const target = path.resolve(path.dirname(filename), name);
      const choices = path.extname(target) ? [target] : [`${target}.js`, `${target}.mjs`];
      const resolved = choices.find(choice => modules.has(choice) || compiled.has(choice));
      assert.ok(resolved, `Unresolved import: ${name}`);
      return load(resolved);
    };
    new Function('require', 'module', 'exports', compiled.get(filename))(localRequire, module, module.exports);
    return module.exports;
  }
  return { manual: load(abs(MANUAL)), paypal: load(abs(PAYPAL)), effects, writes, store };
}

test('el contrato compartido normaliza notas opcionales y conserva saltos de línea sin truncar', () => {
  assert.equal(MAX_CUSTOMER_NOTES_LENGTH, 1000);
  for (const value of [undefined, null, '', ' \n\t ']) assert.equal(normalizeCustomerNotes(value), '');
  assert.equal(normalizeCustomerNotes('  Recibe María.\nTocar timbre.  '), 'Recibe María.\nTocar timbre.');
  assert.equal(normalizeCustomerNotes(`  ${'x'.repeat(1000)}  `), 'x'.repeat(1000));
  for (const value of [false, 123, [], {}]) assert.throws(() => normalizeCustomerNotes(value), /deben ser texto/);
  assert.throws(() => normalizeCustomerNotes('x'.repeat(1001)), /hasta 1000 caracteres/);
});

test('SINPE guarda notas del cliente en el pedido, separadas de las notas internas y del CRM', async () => {
  const h = loadServices();
  const notes = '  Dejar en recepción.\nLlamar al llegar.  ';
  const result = await h.manual.createOrder(orderFixture({ customerNotes: notes, notes: 'Nota interna falsificada' }));
  assert.equal(result.orderId, 'local-order');
  assert.equal(h.effects.commits, 1);
  assert.equal(h.effects.callables.length, 0);
  const order = h.store.get('orders/local-order');
  assert.equal(order.customerNotes, notes.trim());
  assert.equal(order.notes, '');
  assert.equal(order.paymentMethod, 'sinpe');
  assert.equal(order.paymentStatus, 'pendiente');
  assert.equal(order.status, 'pendiente_pago');
  assert.equal(order.total, 104000);
  assert.equal(order.backorderDeposit, 32000);
  assert.equal(order.uid, 'customer-1');
  assert.equal(h.store.get('crm_contacts/customer-1').customerNotes, undefined);
  assert.equal(h.store.get('orders/local-order/items/item_0').customerNotes, undefined);
});

test('agregar notas a SINPE no modifica importes, apartados, líneas ni estado financiero', async () => {
  const before = loadServices();
  const after = loadServices();
  await before.manual.createOrder(orderFixture());
  await after.manual.createOrder(orderFixture({ customerNotes: '{"total":1,"paymentStatus":"pagado"}' }));
  const comparable = value => {
    const result = structuredClone(value);
    for (const key of ['customerNotes', 'createdAt', 'updatedAt', 'orderNumber']) delete result[key];
    return result;
  };
  assert.deepEqual(comparable(after.store.get('orders/local-order')), comparable(before.store.get('orders/local-order')));
  assert.deepEqual(after.store.get('orders/local-order/items/item_0'), before.store.get('orders/local-order/items/item_0'));
  assert.deepEqual(after.store.get('orders/local-order/items/item_1'), before.store.get('orders/local-order/items/item_1'));
});

test('PayPal transmite notas normalizadas al callable junto con IDs y cantidades, sin autoridad financiera del carrito', async () => {
  const h = loadServices();
  const body = orderFixture({ customerNotes: '  Entrega por la tarde.  ', notes: 'Internas falsas', paymentStatus: 'pagado', total: 1,
    depositTotal: 1, remainingTotal: 1, paypal: { paid: true } });
  const result = await h.paypal.createPaypalPendingOrder(body);
  assert.deepEqual(result, { orderId: 'server-order', orderNumber: 'AP-TEST' });
  assert.deepEqual(h.effects.callables, [{ name: 'createOrderWithReservation', data: {
    paymentMethod: 'paypal', customerName: body.customerName, customerEmail: body.customerEmail,
    customerPhone: body.customerPhone, customerNotes: 'Entrega por la tarde.',
    shippingAddress: body.shippingAddress, shippingType: body.shippingType,
    items: [{ productId: 'stock', variantId: 'v1', quantity: 1 }, { productId: 'backorder', variantId: 'v2', quantity: 2 }],
  } }]);
  assert.equal(h.effects.commits, 0);
});

for (const method of ['manual', 'paypal']) {
  const create = (h, body) => method === 'manual' ? h.manual.createOrder(body) : h.paypal.createPaypalPendingOrder(body);
  test(`${method}: notas omitidas o vacías siguen permitiendo crear el pedido`, async () => {
    for (const customerNotes of [undefined, null, '', ' \n ']) {
      const h = loadServices();
      await create(h, orderFixture(customerNotes === undefined ? {} : { customerNotes }));
      const saved = method === 'manual' ? h.store.get('orders/local-order') : h.effects.callables[0].data;
      assert.equal(saved.customerNotes, '');
    }
  });
  test(`${method}: 1000 caracteres se conservan y 1001 se rechazan antes de cualquier escritura`, async () => {
    const valid = loadServices();
    await create(valid, orderFixture({ customerNotes: 'x'.repeat(1000) }));
    const saved = method === 'manual' ? valid.store.get('orders/local-order') : valid.effects.callables[0].data;
    assert.equal(saved.customerNotes.length, 1000);
    for (const value of ['x'.repeat(1001), false, 123, [], {}]) {
      const h = loadServices();
      await assert.rejects(async () => create(h, orderFixture({ customerNotes: value })),
        typeof value === 'string' ? /hasta 1000 caracteres/ : /deben ser texto/);
      assert.equal(h.effects.refs, 0);
      assert.equal(h.effects.batches, 0);
      assert.equal(h.effects.commits, 0);
      assert.equal(h.effects.callables.length, 0);
      assert.equal(h.writes.length, 0);
    }
  });
}
