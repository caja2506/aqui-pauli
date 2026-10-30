// Render real customer/admin screens and invoke their actual handlers. All
// network, Firestore and cash-recording operations are isolated local mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { transformWithEsbuild } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const abs = relative => path.join(root, relative);
const ADMIN = 'src/pages/admin/OrdersPage.jsx';
const CUSTOMER = 'src/pages/store/MyOrdersPage.jsx';
const compiled = new Map(await Promise.all([
  ADMIN, CUSTOMER, 'src/components/ui/ConfirmDialog.jsx',
  'src/components/ui/StatusBadge.jsx', 'src/components/ui/EmptyState.jsx',
  'src/utils/constants.js', 'src/utils/formatters.js',
].map(async relative => {
  const filename = abs(relative);
  const { code } = await transformWithEsbuild(await readFile(filename, 'utf8'), filename,
    { loader: filename.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic', format: 'cjs', target: 'es2022' });
  return [filename, code];
})));

const baseOrder = {
  id: 'cod-test', orderNumber: 'AP-COD-TEST', customerName: 'Cliente de prueba',
  paymentMethod: 'contra_entrega', paymentStatus: 'pendiente', status: 'pendiente_pago',
  total: 52000, subtotal: 52000, shippingCost: 0, createdAt: '2026-10-30T12:00:00Z',
  itemsSummary: [{ productId: 'perfume', variantId: '100ml', productName: 'Perfume',
    variantName: '100 ml', price: 52000, quantity: 1, supplyType: 'stock_propio', lineTotal: 52000 }],
};
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const childText = node => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(childText).join('');
  return React.isValidElement(node) ? childText(node.props.children) : '';
};

function fixture({ relative = ADMIN, orders = [baseOrder], callable = async () => ({ data: { success: true } }), updateStatus = async () => {} } = {}) {
  const calls = { callable: [], status: [], firestoreWrites: [] };
  const slots = [];
  let hookIndex = 0;
  let elements = [];
  let dialogs = [];
  let html = '';
  const forbidden = name => () => { throw new Error(`External operation forbidden: ${name}`); };
  const modules = new Map([
    [abs('src/firebase.js'), { db: {}, functions: {} }],
    [abs('src/hooks/useCollection.js'), { useCollection: () => ({ data: orders, loading: false }) }],
    [abs('src/contexts/AuthContext.js'), { useAuth: () => ({ user: { uid: 'customer' }, loading: false }) }],
    [abs('src/services/orderService.js'), { updateOrderStatus: async (...args) => { calls.status.push(args); return updateStatus(...args); } }],
  ]);
  const cache = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    assert.ok(compiled.has(filename), `Unexpected import: ${path.relative(root, filename)}`);
    const module = { exports: {} }; cache.set(filename, module);
    const localRequire = name => {
      if (name === 'react' && [abs(ADMIN), abs(CUSTOMER)].includes(filename)) return {
        ...React,
        useState(initial) {
          const index = hookIndex++;
          if (!Object.hasOwn(slots, index)) slots[index] = filename === abs(CUSTOMER)
            ? (index === 0 ? orders : index === 1 ? false : initial)
            : (typeof initial === 'function' ? initial() : initial);
          return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
        },
        useRef(initial) {
          const index = hookIndex++;
          if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
          return slots[index];
        },
        useEffect() {},
      };
      if (name === 'react/jsx-runtime') {
        const runtime = require(name);
        return { ...runtime, ...Object.fromEntries(['jsx', 'jsxs'].map(key => [key, (type, props, ...rest) => {
          if (typeof type === 'string') elements.push({ type, props });
          if (typeof type === 'function' && props?.onConfirm && props?.onClose) dialogs.push(props);
          return runtime[key](type, props, ...rest);
        }])) };
      }
      if (['react', 'react-router-dom', 'lucide-react'].includes(name)) return require(name);
      if (name === 'firebase/functions') return { httpsCallable: (_functions, endpoint) => async data => {
        calls.callable.push({ endpoint, data }); return callable(data);
      } };
      if (name === 'firebase/firestore') return {
        collection: forbidden('collection'), getDocs: forbidden('getDocs'), doc: forbidden('doc'),
        query: forbidden('query'), where: forbidden('where'), orderBy: forbidden('orderBy'),
        updateDoc: (...args) => { calls.firestoreWrites.push(args); throw new Error('Direct Firestore write forbidden'); },
      };
      assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`);
      const target = path.resolve(path.dirname(filename), name);
      const resolved = (path.extname(target) ? [target] : [`${target}.js`, `${target}.jsx`])
        .find(candidate => modules.has(candidate) || compiled.has(candidate));
      assert.ok(resolved, `Unresolved import: ${name}`);
      return load(resolved);
    };
    new Function('require', 'module', 'exports', compiled.get(filename))(localRequire, module, module.exports);
    return module.exports;
  }
  const Component = load(abs(relative)).default;
  function render() {
    hookIndex = 0; elements = []; dialogs = [];
    html = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Component)));
    return html;
  }
  render();
  return {
    calls, render,
    get html() { return html; },
    get elements() { return elements; },
    get dialog() { return dialogs.find(dialog => dialog.isOpen); },
    button(label) { return elements.find(element => element.type === 'button' && childText(element.props.children).trim() === label)?.props; },
    selector(order = orders[0]) { return elements.find(element => element.type === 'select' && element.props['aria-label'] === `Estado del pedido ${order.orderNumber}`)?.props; },
    async expand(order = orders[0]) {
      const card = elements.find(element => element.props['data-testid'] === `order-summary-${order.id}`);
      assert.ok(card); await card.props.onClick(); render();
    },
  };
}

test('Mis Pedidos explica efectivo al recibir y no solicita comprobante para contra entrega', () => {
  const page = fixture({ relative: CUSTOMER });
  assert.match(text(page.html), /Contra entrega \(efectivo\)/);
  assert.match(text(page.html), /Pagás ₡52 000 en efectivo al recibir tu pedido/);
  assert.doesNotMatch(page.html, /Enviar Comprobante|Envío mi comprobante/);
});

test('Mis Pedidos distingue efectivo cobrado y cancelación sin volver a pedir el monto', () => {
  for (const paymentStatus of ['pagado', 'verificado']) {
    const page = fixture({ relative: CUSTOMER, orders: [{ ...baseOrder, paymentStatus, status: 'entregado' }] });
    assert.match(text(page.html), /El pago en efectivo ya está registrado/);
    assert.doesNotMatch(text(page.html), /Pagás.*al recibir|Enviar Comprobante/);
  }
  const cancelled = fixture({ relative: CUSTOMER, orders: [{ ...baseOrder, status: 'cancelado', remainingTotal: 0 }] });
  assert.match(text(cancelled.html), /No tenés un cobro contra entrega pendiente/);
  assert.doesNotMatch(text(cancelled.html), /Pagás.*al recibir|Enviar Comprobante/);
});

test('Mis Pedidos conserva comprobante para SINPE pendiente', () => {
  const page = fixture({ relative: CUSTOMER, orders: [{ ...baseOrder, paymentMethod: 'sinpe' }] });
  assert.match(text(page.html), /Enviar Comprobante por WhatsApp/);
  assert.doesNotMatch(page.html, /my-order-cash-on-delivery/);
});

test('admin ofrece confirmar efectivo explícitamente y no ofrece Pagado ni pide comprobante', async () => {
  const page = fixture(); await page.expand();
  assert.ok(page.button('Confirmar efectivo recibido'));
  assert.match(text(page.html), /Cobrar ₡52 000 en efectivo al entregar/);
  assert.doesNotMatch(page.html, /Sin comprobante recibido/);
  const options = React.Children.toArray(page.selector().children).map(option => option.props.value);
  assert.ok(!options.includes('pagado'));
  assert.ok(!options.includes('revision_manual'));
  assert.ok(options.includes('cancelado'));
  assert.doesNotMatch(page.html, /title="Eliminar pedido"/);
  page.button('Confirmar efectivo recibido').onClick(); page.render();
  assert.match(page.dialog.message, /ya recibiste ₡52\s000 en efectivo/);
  assert.match(page.dialog.message, /AP-COD-TEST/);
  assert.equal(page.calls.callable.length, 0, 'opening the confirmation never records payment');
});

test('confirmar efectivo usa callable, bloquea doble toque y no escribe datos financieros directamente', async () => {
  let complete;
  const page = fixture({ callable: () => new Promise(resolve => { complete = resolve; }) });
  await page.expand(); page.button('Confirmar efectivo recibido').onClick(); page.render();
  const confirm = page.dialog.onConfirm;
  const pending = confirm(); await confirm();
  assert.deepEqual(page.calls.callable, [{ endpoint: 'manageCashOnDeliveryOrder', data: { orderId: 'cod-test', action: 'confirm_payment' } }]);
  page.render();
  assert.match(text(page.html), /Registrando efectivo recibido/);
  assert.equal(page.button('Registrando…').disabled, true);
  assert.equal(page.selector().disabled, true);
  complete({ data: { success: true } }); await pending;
  page.render();
  assert.deepEqual(page.calls.firestoreWrites, []);
  assert.deepEqual(page.calls.status, []);
});

test('un fallo al registrar efectivo se muestra y permite reintentar sin fingir pago exitoso', async () => {
  const page = fixture({ callable: async () => { throw new Error('La reserva requiere revisión.'); } });
  await page.expand(); page.button('Confirmar efectivo recibido').onClick(); page.render();
  await page.dialog.onConfirm(); page.render();
  assert.match(page.html, /role="alert"[^>]*>La reserva requiere revisión\./);
  assert.equal(page.button('Confirmar efectivo recibido').disabled, false);
  assert.doesNotMatch(page.html, /Pago en efectivo registrado/);
  assert.deepEqual(page.calls.firestoreWrites, []);
});

test('cancelar contra entrega requiere confirmación y libera por callable; preparar conserva el flujo existente', async () => {
  const page = fixture();
  page.selector().onChange({ stopPropagation() {}, target: { value: 'cancelado' } }); page.render();
  assert.match(page.dialog.message, /Se liberará el stock reservado/);
  assert.match(page.dialog.message, /Cancelá solo si los productos siguen en la tienda o ya fueron devueltos; volverán a estar disponibles para la venta/);
  assert.equal(page.calls.callable.length, 0);
  await page.dialog.onConfirm();
  assert.deepEqual(page.calls.callable, [{ endpoint: 'manageCashOnDeliveryOrder', data: { orderId: 'cod-test', action: 'cancel' } }]);
  assert.deepEqual(page.calls.status, []);
  page.selector().onChange({ stopPropagation() {}, target: { value: 'preparando' } });
  assert.deepEqual(page.calls.status, [['cod-test', 'preparando']]);
  assert.deepEqual(page.calls.firestoreWrites, []);
});

test('contra entrega ofrece solo el estado actual y los posteriores; no retrocede ni usa revisión o Pagado', async () => {
  const progress = ['pendiente_pago', 'por_preparar', 'preparando', 'enviado', 'entregado'];
  for (let index = 0; index < progress.length; index += 1) {
    for (const paymentStatus of ['pendiente', 'pagado']) {
      const page = fixture({ orders: [{ ...baseOrder, status: progress[index], paymentStatus }] });
      const options = React.Children.toArray(page.selector().children).map(option => option.props.value);
      assert.deepEqual(options, [...progress.slice(index),
        ...(paymentStatus === 'pendiente' && progress[index] !== 'entregado' ? ['cancelado'] : [])]);
      for (const disallowed of [...progress.slice(0, index), 'revision_manual', 'pagado']) {
        await page.selector().onChange({ stopPropagation() {}, target: { value: disallowed } });
      }
      page.render();
      assert.deepEqual(page.calls.status, []);
      assert.deepEqual(page.calls.callable, []);
      assert.equal(page.dialog, undefined);
      assert.doesNotMatch(page.html, /title="Eliminar pedido"/);
    }
  }
  const cancelled = fixture({ orders: [{ ...baseOrder, status: 'cancelado' }] });
  assert.deepEqual(React.Children.toArray(cancelled.selector().children).map(option => option.props.value), ['cancelado']);
  assert.equal(cancelled.selector().disabled, true);
  await cancelled.selector().onChange({ stopPropagation() {}, target: { value: 'preparando' } });
  assert.deepEqual(cancelled.calls.status, []);
});

test('el error de cambio de estado es visible y vuelve a habilitar el control sin cambiar finanzas', async () => {
  const page = fixture({ updateStatus: async () => { throw new Error('No se pudo actualizar el estado.'); } });
  await page.expand();
  await page.selector().onChange({ stopPropagation() {}, target: { value: 'preparando' } });
  page.render();
  assert.match(page.html, /role="alert"[^>]*>No se pudo actualizar el estado\./);
  assert.equal(page.selector().value, 'pendiente_pago');
  assert.equal(page.selector().disabled, false);
  assert.equal(page.button('Confirmar efectivo recibido').disabled, false);
  assert.deepEqual(page.calls.status, [['cod-test', 'preparando']]);
  assert.deepEqual(page.calls.callable, []);
  assert.deepEqual(page.calls.firestoreWrites, []);
});

test('un cambio de estado pendiente bloquea doble cambio y confirmación de efectivo concurrente', async () => {
  let complete;
  const page = fixture({ updateStatus: () => new Promise(resolve => { complete = resolve; }) });
  await page.expand();
  const selector = page.selector();
  const confirmCash = page.button('Confirmar efectivo recibido');
  const pending = selector.onChange({ stopPropagation() {}, target: { value: 'preparando' } });
  await selector.onChange({ stopPropagation() {}, target: { value: 'enviado' } });
  confirmCash.onClick(); page.render();
  assert.equal(page.dialog, undefined);
  assert.equal(page.selector().disabled, true);
  assert.equal(page.button('Confirmar efectivo recibido').disabled, true);
  assert.match(text(page.html), /Actualizando estado del pedido/);
  assert.deepEqual(page.calls.status, [['cod-test', 'preparando']]);
  assert.deepEqual(page.calls.callable, []);
  complete(); await pending; page.render();
  assert.equal(page.selector().disabled, false);
});

test('admin no vuelve a cobrar pagados/cancelados y permite acreditar un entregado todavía pendiente', async () => {
  for (const changes of [{ paymentStatus: 'pagado' }, { paymentStatus: 'verificado' }, { status: 'cancelado' }]) {
    const page = fixture({ orders: [{ ...baseOrder, ...changes }] }); await page.expand();
    assert.ok(!page.button('Confirmar efectivo recibido'));
    page.selector().onChange({ stopPropagation() {}, target: { value: 'pagado' } }); page.render();
    assert.equal(page.dialog, undefined);
    assert.deepEqual(page.calls.callable, []);
  }
  const delivered = fixture({ orders: [{ ...baseOrder, status: 'entregado' }] }); await delivered.expand();
  assert.ok(delivered.button('Confirmar efectivo recibido'));
  assert.ok(!React.Children.toArray(delivered.selector().children).some(option => option.props.value === 'cancelado'));
  delivered.selector().onChange({ stopPropagation() {}, target: { value: 'cancelado' } }); delivered.render();
  assert.equal(delivered.dialog, undefined);
});

test('admin conserva opciones y aprobación manual de los otros métodos', async () => {
  const page = fixture({ orders: [{ ...baseOrder, paymentMethod: 'sinpe', paymentStatus: 'verificando' }] }); await page.expand();
  assert.ok(page.button('Aprobar'));
  assert.ok(!page.button('Confirmar efectivo recibido'));
  assert.match(page.html, /title="Eliminar pedido"/);
  assert.ok(React.Children.toArray(page.selector().children).some(option => option.props.value === 'pagado'));
  page.selector().onChange({ stopPropagation() {}, target: { value: 'enviado' } });
  assert.deepEqual(page.calls.status, [['cod-test', 'enviado']]);
  assert.deepEqual(page.calls.callable, []);
});
