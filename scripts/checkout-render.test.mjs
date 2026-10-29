// Run: node --test scripts/checkout-render.test.mjs
// Render the actual source with React/ReactDOMServer. Only auth, cart, external
// services and gateway boundaries are fixtures; no Firebase or payment calls run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { transformWithEsbuild } from 'vite';
import { formatCRC } from '../src/utils/formatters.js';
import { paypalQuoteKey, isPayablePaypalQuote, samePaypalQuote } from '../src/services/payments/paypalQuote.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const CHECKOUT = 'src/pages/store/CheckoutPage.jsx';
const CART = 'src/components/storefront/CartDrawer.jsx';
const CONFIRMATION = 'src/pages/store/OrderConfirmation.jsx';
const PAYPAL_PANEL = 'src/components/payments/PaypalPanel.jsx';
const realFiles = [
  CHECKOUT, CART, CONFIRMATION, PAYPAL_PANEL,
  'src/utils/backorder.js', 'src/utils/constants.js', 'src/utils/formatters.js',
  'src/services/payments/registry.js', 'src/data/costaRicaTerritorial.js',
  'src/components/ui/CopyButton.jsx', 'src/components/ui/LoadingSpinner.jsx',
  'src/services/payments/paypalQuote.js',
];

// Compile unmodified files, including their actual imports. Removing the backorder
// import therefore produces a render-time ReferenceError instead of a false pass.
const compiled = new Map(await Promise.all(realFiles.map(async (relative) => {
  const filename = path.join(root, relative);
  const source = await readFile(filename, 'utf8');
  const result = await transformWithEsbuild(source, filename, {
    loader: filename.endsWith('.jsx') ? 'jsx' : 'js',
    jsx: 'automatic', format: 'cjs', target: 'es2022', sourcemap: false,
  });
  return [filename, result.code];
})));

const forbidden = (name) => () => { throw new Error(`External operation forbidden in render test: ${name}`); };
const line = (supplyType, price, id = supplyType) => ({
  productId: id, variantId: 'unica', productName: supplyType === 'bajo_pedido' ? 'Versace Bajo pedido' : 'Perfume en stock',
  variantName: '100 ml', price, quantity: 1, supplyType, imageUrl: '',
});
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const contains = (html, expected) => assert.ok(text(html).includes(text(expected)), `Missing rendered text: ${expected}`);
const serverQuote = ({ total, balance = 0, deposit = 0, backorder = 0, shipping = 0 }) => ({
  crcSubtotal: total - shipping, crcShipping: shipping, crcTotal: total,
  crcPayNow: total - balance, crcBalanceDue: balance,
  crcBackorderSubtotal: backorder, crcDepositTotal: deposit,
  hasBackorder: backorder > 0, depositPercent: 0.5,
  usdTotal: Math.round((total - balance) / 500 * 100) / 100,
  fxRate: 500, fxBufferPct: 0, fxSource: 'test', fxDate: null, currency: 'USD',
});

function renderPage(relative, options = {}) {
  const items = options.items || [];
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const shippingCost = options.shippingCost || 0;
  const availability = options.paypalAvailable ? { paypal: { available: true } } : {};
  const paypalTotals = [];
  const paypalEffects = [];
  const paypalRefs = [];
  const paypalStateUpdates = [];
  const cache = new Map();
  const abs = (name) => path.join(root, name);
  const user = { uid: 'render-test-user', displayName: 'Ana Prueba', email: 'ana@example.invalid', isAnonymous: false };
  const paypalProvider = {
    id: 'paypal', kind: 'online', label: 'PayPal / Tarjeta',
    getAvailability: forbidden('PayPal availability'),
    Panel: (props) => {
      const { totalCRC } = props;
      paypalTotals.push(totalCRC);
      return React.createElement('div', { 'data-testid': 'paypal-panel', 'data-total-crc': totalCRC },
        React.createElement(load(abs(PAYPAL_PANEL)).default, props));
    },
  };
  const modules = new Map([
    [abs('src/contexts/AuthContext.js'), { useAuth: () => ({ user, loading: false, ensureGuestSession: forbidden('anonymous auth') }) }],
    [abs('src/contexts/CartContext.js'), { useCart: () => ({
      items, subtotal, itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      isCartOpen: options.cartOpen === true, setIsCartOpen: forbidden('cart mutation'),
      clearCart: forbidden('cart clear'), removeItem: forbidden('item removal'), updateQuantity: forbidden('quantity change'),
    }) }],
    [abs('src/firebase.js'), { db: {} }],
    [abs('src/services/orderService.js'), { createOrder: forbidden('order creation') }],
    [abs('src/services/payments/paypalClient.js'), { ...Object.fromEntries([
      'createPaypalPendingOrder', 'loadPaypalSdk', 'paypalCaptureOrder', 'paypalCreateOrder', 'paypalGetConfig', 'paypalGetQuote',
    ].map((name) => [name, forbidden(name)])), ...(options.paypalClient || {}) }],
    [abs('src/services/shippingService.js'), {
      calculateShippingCost: () => shippingCost,
      getShippingOptions: () => [{ type: 'normal', label: 'Envío normal', estimatedDays: '3 días', price: shippingCost }],
    }],
    [abs('src/services/payments/paypalProvider.js'), { paypalProvider }],
    [abs('src/services/payments/tilopayProvider.js'), { tilopayProvider: {
      id: 'tilopay', kind: 'online', label: 'Tarjeta',
      getAvailability: forbidden('Tilopay availability'), Panel: forbidden('Tilopay panel'),
    } }],
    [abs('src/components/auth/SaveAccountPrompt.js'), { __esModule: true, default: () => null }],
  ]);

  // SSR does not run effects. Seed the form, loaded availability and saved order
  // as initial state, while delegating every hook to the real React dispatcher.
  // This exercises the actual render branches; it does not test auth/SDK effects.
  let checkoutStateSlot = 0;
  const checkoutReact = {
    ...React,
    useState(initial) {
      const slot = checkoutStateSlot++;
      let value = initial;
      if (initial && typeof initial === 'object' && Object.hasOwn(initial, 'paymentMethod')) {
        value = { ...initial, paymentMethod: options.paymentMethod || 'sinpe',
          provincia: 'Alajuela', canton: 'Grecia', distrito: 'Grecia' };
      }
      if (slot === 5) {
        assert.deepEqual(initial, {}, 'Update availability fixture if CheckoutPage state layout changes');
        value = availability;
      }
      if (slot === 6) {
        assert.equal(initial, null, 'Update quote fixture if CheckoutPage state layout changes');
        value = options.paypalQuote ? { key: paypalQuoteKey(items, 'Grecia', 'normal'), quote: options.paypalQuote } : null;
      }
      return React.useState(value);
    },
  };
  const confirmationReact = {
    ...React,
    useState(initial) {
      return React.useState(initial === null && options.savedOrder ? options.savedOrder : initial);
    },
  };
  let paypalStateSlot = 0;
  const paypalReact = {
    ...React,
    useEffect(effect, dependencies) {
      paypalEffects.push(effect);
      return React.useEffect(effect, dependencies);
    },
    useRef(initial) {
      const ref = React.useRef(initial);
      paypalRefs.push(ref);
      return ref;
    },
    useState(initial) {
      const slot = paypalStateSlot++;
      const value = slot === 0 ? { enabled: true, clientId: 'test-only', env: 'sandbox' }
        : slot === 1 && options.paypalQuote ? { key: paypalQuoteKey(items, 'Grecia', 'normal'), quote: options.paypalQuote } : initial;
      const [state, setState] = React.useState(value);
      return [state, (next) => { paypalStateUpdates.push({ slot, value: next }); setState(next); }];
    },
  };

  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const code = compiled.get(filename);
    assert.ok(code, `Unexpected source dependency: ${path.relative(root, filename)}`);
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = (name) => {
      if (name === 'react') return filename === abs(CHECKOUT) ? checkoutReact
        : filename === abs(CONFIRMATION) ? confirmationReact : filename === abs(PAYPAL_PANEL) ? paypalReact : React;
      if (['react/jsx-runtime', 'react-router-dom', 'lucide-react'].includes(name)) return require(name);
      if (name === 'firebase/firestore') return { doc: forbidden('Firestore doc'), getDoc: forbidden('Firestore get') };
      assert.ok(name.startsWith('.'), `Unexpected external dependency: ${name}`);
      const target = path.resolve(path.dirname(filename), name);
      const candidates = path.extname(target) ? [target] : [`${target}.js`, `${target}.jsx`];
      const found = candidates.find((candidate) => modules.has(candidate) || compiled.has(candidate));
      assert.ok(found, `Unresolved source import ${name} from ${filename}`);
      return load(found);
    };
    new Function('require', 'module', 'exports', '__filename', '__dirname', code)(
      localRequire, module, module.exports, filename, path.dirname(filename));
    return module.exports;
  }

  const Component = load(abs(relative)).default;
  const confirmation = relative === CONFIRMATION;
  const pathname = confirmation ? '/orden-confirmada/order-render' : '/checkout';
  const routePath = confirmation ? '/orden-confirmada/:orderId' : '/checkout';
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, {
    initialEntries: [{ pathname, state: options.locationState || null }],
  }, React.createElement(Routes, null, React.createElement(Route, {
    path: routePath, element: React.createElement(Component, options.componentProps),
  }))));
  return { html, paypalTotals, paypalEffects, paypalRefs, paypalStateUpdates };
}

test('checkout vacío renderiza su estado vacío', () => {
  const { html } = renderPage(CHECKOUT);
  contains(html, 'Tu carrito está vacío');
  assert.doesNotMatch(html, /data-testid="deposit-summary"/);
});

test('checkout de stock cobra el total y no presenta apartado', () => {
  const { html } = renderPage(CHECKOUT, { items: [line('stock_propio', 30000)] });
  contains(html, `Confirmar Pedido · ${formatCRC(30000)}`);
  assert.doesNotMatch(html, /data-testid="deposit-summary"/);
});

test('Bajo pedido de ₡47.000 renderiza SINPE, apartado ₡23.500 y saldo ₡23.500', () => {
  const { html } = renderPage(CHECKOUT, { items: [line('bajo_pedido', 47000)], paymentMethod: 'sinpe' });
  assert.match(html, /data-testid="deposit-summary"/);
  contains(html, `Apartá con ${formatCRC(23500)} (50%)`);
  contains(html, `Saldo restante ${formatCRC(23500)}`);
  contains(html, '8310-0015');
  contains(html, 'Carlos Jiménez Arias');
});

test('mixto paga stock y envío completos más 50% únicamente de Bajo pedido', () => {
  const { html } = renderPage(CHECKOUT, {
    items: [line('stock_propio', 30000), line('bajo_pedido', 10000)], shippingCost: 5000,
  });
  contains(html, `Apartá con ${formatCRC(40000)} (50%)`);
  contains(html, `Saldo restante ${formatCRC(5000)}`);
  contains(html, `Total del pedido ${formatCRC(45000)}`);
  contains(html, `de los productos bajo pedido (${formatCRC(5000)})`);
});

test('carrito lateral abierto renderiza Bajo pedido y acceso a checkout', () => {
  const { html } = renderPage(CART, { items: [line('bajo_pedido', 47000)], cartOpen: true });
  contains(html, 'Mi Carrito');
  contains(html, 'Versace Bajo pedido');
  contains(html, formatCRC(47000));
  contains(html, 'Proceder al Checkout');
  assert.match(html, /href="\/checkout"/);
});

test('confirmación SINPE recargada calcula el apartado desde el pedido guardado', () => {
  const { html } = renderPage(CONFIRMATION, { savedOrder: {
    orderNumber: 'AP-RENDER', total: 47000, paymentMethod: 'sinpe', shippingCost: 0,
    backorderDeposit: 23500, depositTotal: 23500,
    itemsSummary: [line('bajo_pedido', 47000)],
  } });
  assert.match(html, /data-testid="sinpe-instructions"/);
  contains(html, 'AP-RENDER');
  contains(html, `Monto a pagar ahora (apartado) ${formatCRC(23500)}`);
  contains(html, `Saldo restante: ${formatCRC(23500)}`);
  contains(html, '50% de los productos bajo pedido');
  contains(html, '8310-0015');
  contains(html, 'Carlos Jiménez Arias');
  assert.match(html, /aria-label="Copiar monto"/);
  const whatsappHref = html.match(/href="(https:\/\/wa\.me\/[^"]+)"/)?.[1];
  assert.ok(whatsappHref, 'Missing WhatsApp proof link');
  const message = new URL(whatsappHref.replaceAll('&amp;', '&')).searchParams.get('text');
  assert.ok(message.includes(`Pagué *${formatCRC(23500)}*`), 'WhatsApp must show the agreed payment amount');
  assert.ok(message.includes('apartado, 50% de los productos bajo pedido'));
  assert.ok(message.includes('AP-RENDER'));
  assert.ok(!message.includes('25%'));
});

test('PayPal conserva recomendado y muestra apartado más stock y envío del servidor en el pedido mixto', () => {
  const { html, paypalTotals } = renderPage(CHECKOUT, {
    items: [line('stock_propio', 30000), line('bajo_pedido', 10000)], shippingCost: 5000,
    paypalAvailable: true, paymentMethod: 'paypal',
    paypalQuote: serverQuote({ total: 45000, balance: 5000, deposit: 5000, backorder: 10000, shipping: 5000 }),
  });
  contains(html, 'Recomendado');
  contains(html, 'Pagá con PayPal y comprás protegido');
  assert.ok(html.indexOf('value="paypal"') < html.indexOf('value="sinpe"'));
  assert.deepEqual(paypalTotals, [45000]);
  assert.match(html, /data-testid="paypal-panel"/);
  assert.match(html, /data-testid="deposit-summary"/);
  contains(html, `Pagás ahora ${formatCRC(40000)} (apartado 50%)`);
  contains(html, `Total del pedido: ${formatCRC(45000)}`);
  contains(html, `Saldo pendiente: ${formatCRC(5000)}`);
  contains(html, 'Cobro de hoy en PayPal: US$ 80.00');
  assert.doesNotMatch(html, /type="submit"/);
});

test('PayPal Bajo pedido de ₡32.000 cobra y anuncia ₡16.000 ahora con saldo ₡16.000', () => {
  const { html } = renderPage(CHECKOUT, {
    items: [line('bajo_pedido', 32000)], paypalAvailable: true, paymentMethod: 'paypal',
    paypalQuote: serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 }),
  });
  contains(html, `Pagás ahora ${formatCRC(16000)} (apartado 50%)`);
  contains(html, `Saldo pendiente: ${formatCRC(16000)}`);
  contains(html, 'Cobro de hoy en PayPal: US$ 32.00');
  assert.ok(text(html).split(text(`Pagás ahora ${formatCRC(16000)} (apartado 50%)`)).length >= 3,
    'The server due-now amount must appear beside PayPal buttons and in the summary');
});

test('PayPal de stock conserva el pago completo sin texto de apartado', () => {
  const { html } = renderPage(CHECKOUT, {
    items: [line('stock_propio', 32000)], paypalAvailable: true, paymentMethod: 'paypal',
    paypalQuote: serverQuote({ total: 32000 }),
  });
  contains(html, `Pagás ahora ${formatCRC(32000)}`);
  contains(html, 'Cobro de hoy en PayPal: US$ 64.00');
  assert.doesNotMatch(html, /apartado 50%/);
  assert.doesNotMatch(html, /data-testid="deposit-summary"/);
});

test('PayPal espera el contrato de cotización nuevo y no muestra el total completo del backend anterior como cobro', () => {
  for (const paypalQuote of [null, { crcTotal: 32000, usdTotal: 64, fxRate: 500, currency: 'USD' }]) {
    const { html } = renderPage(CHECKOUT, {
      items: [line('bajo_pedido', 32000)], paypalAvailable: true, paymentMethod: 'paypal', paypalQuote,
    });
    assert.doesNotMatch(html, /data-testid="paypal-quote"/);
    assert.doesNotMatch(html, /Cobro de hoy en PayPal/);
    contains(html, 'El servidor confirmará el monto a pagar ahora y el saldo antes de habilitar PayPal.');
  }
});

test('el resumen y el panel de PayPal prefieren los importes del servidor sobre precios viejos del carrito', () => {
  const { html } = renderPage(CHECKOUT, {
    items: [line('bajo_pedido', 32000)], paypalAvailable: true, paymentMethod: 'paypal',
    paypalQuote: serverQuote({ total: 36000, balance: 18000, deposit: 18000, backorder: 36000 }),
  });
  contains(html, `Pagás ahora ${formatCRC(18000)} (apartado 50%)`);
  contains(html, `Total del pedido: ${formatCRC(36000)}`);
  assert.ok(!text(html).includes(text(`Pagás ahora ${formatCRC(16000)}`)));
});

test('cotizaciones incompletas o cambiadas no se consideran autorización del importe mostrado', () => {
  const quote = serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 });
  assert.equal(isPayablePaypalQuote(quote), true);
  assert.equal(samePaypalQuote(quote, { ...quote }), true);
  for (const patch of [{ crcPayNow: undefined }, { usdTotal: NaN }, { currency: 'CRC' }, { crcBalanceDue: 0 }, { depositPercent: 0.25 }]) {
    assert.equal(isPayablePaypalQuote({ ...quote, ...patch }), false);
    assert.equal(samePaypalQuote(quote, { ...quote, ...patch }), false);
  }
  assert.equal(samePaypalQuote(quote, { ...quote, usdTotal: 33, fxRate: 485 }), false);
  assert.notEqual(paypalQuoteKey([line('bajo_pedido', 32000)], 'Grecia', 'normal'),
    paypalQuoteKey([{ ...line('bajo_pedido', 32000), quantity: 2 }], 'Grecia', 'normal'));
});

// Exercise the actual SDK callbacks from the compiled component. Only the SDK
// boundary and DOM container are fixtures; there are no remote payment calls.
async function paypalCallbacks({ quote, create, capture, refresh, pending, onPaid } = {}) {
  let callbacks;
  let sdkLoads = 0;
  const items = [line('bajo_pedido', 32000)];
  const rendered = renderPage(PAYPAL_PANEL, {
    items, paypalQuote: quote,
    paypalClient: {
      loadPaypalSdk: async () => { sdkLoads += 1; return { Buttons: (value) => { callbacks = value; return { render() {}, close() {} }; } }; },
      paypalCreateOrder: create || forbidden('unexpected provider order creation'),
      paypalCaptureOrder: capture || forbidden('unexpected payment capture'),
      paypalGetQuote: refresh || forbidden('unexpected quote refresh'),
    },
    componentProps: {
      items, canton: 'Grecia', shippingType: 'normal', validateForm: () => true,
      createPendingOrder: pending || (async () => ({ orderId: 'local-order', orderNumber: 'AP-CALLBACK' })),
      onPaid: onPaid || forbidden('unexpected confirmation'),
    },
  });
  rendered.paypalRefs[0].current = {}; // the SDK's own render fixture owns this container
  rendered.paypalEffects.at(-1)();
  await Promise.resolve();
  return { ...rendered, callbacks, sdkLoads };
}

test('SDK envía la cotización mostrada y confirma un apartado con la cotización del servidor', async () => {
  const quote = serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 });
  const calls = [];
  let confirmed;
  const { callbacks } = await paypalCallbacks({
    quote,
    create: async (data) => { calls.push(['create', data]); return { ...quote, paypalOrderId: 'PP-DEPOSIT' }; },
    capture: async (data) => { calls.push(['capture', data]); return { result: 'captured', partial: true }; },
    onPaid: (data) => { confirmed = data; },
  });
  assert.equal(await callbacks.createOrder(), 'PP-DEPOSIT');
  assert.deepEqual(calls[0], ['create', { orderId: 'local-order', expectedQuote: quote }]);
  await callbacks.onApprove({ orderID: 'PP-DEPOSIT' });
  assert.deepEqual(calls[1], ['capture', { orderId: 'local-order', paypalOrderId: 'PP-DEPOSIT' }]);
  assert.equal(confirmed.partial, true);
  assert.equal(confirmed.paypalQuote.crcPayNow, 16000);
  assert.equal(confirmed.paypalQuote.crcBalanceDue, 16000);
});

test('SDK detiene una creación con importe distinto y muestra una cotización nueva para otro clic', async () => {
  const quote = serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 });
  const refreshed = serverQuote({ total: 36000, balance: 18000, deposit: 18000, backorder: 36000 });
  let refreshes = 0;
  const { callbacks, paypalStateUpdates } = await paypalCallbacks({
    quote,
    create: async () => { throw Object.assign(new Error('quote changed'), { code: 'functions/failed-precondition', details: { quote: refreshed } }); },
    refresh: async () => { refreshes += 1; return refreshed; },
  });
  await assert.rejects(callbacks.createOrder(), /quote changed/);
  assert.equal(refreshes, 0, 'The saved attempt quote returned by the server takes precedence over a fresh quote');
  assert.ok(paypalStateUpdates.some(({ value }) => value?.quote?.crcPayNow === 18000));
  assert.ok(paypalStateUpdates.some(({ value }) => typeof value === 'string' && value.includes('volvé a pulsar PayPal')));
});

test('una cotización guardada con otro tipo de cambio permite aprobar el mismo intento sin bucle de recotización', async () => {
  const savedQuote = serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 });
  const freshQuote = { ...savedQuote, fxRate: 400, usdTotal: 40 };
  const expectedQuotes = [];
  const create = async ({ expectedQuote }) => {
    expectedQuotes.push(expectedQuote);
    if (!samePaypalQuote(expectedQuote, savedQuote)) {
      throw Object.assign(new Error('quote changed'), { code: 'functions/failed-precondition', details: { quote: savedQuote } });
    }
    return { ...savedQuote, paypalOrderId: 'PP-EXISTING' };
  };
  const first = await paypalCallbacks({ quote: freshQuote, create });
  await assert.rejects(first.callbacks.createOrder(), /quote changed/);
  const visibleQuote = first.paypalStateUpdates.find(({ value }) => value?.quote?.fxRate === 500).value.quote;
  const nextClick = await paypalCallbacks({ quote: visibleQuote, create });
  assert.equal(await nextClick.callbacks.createOrder(), 'PP-EXISTING');
  assert.deepEqual(expectedQuotes, [freshQuote, savedQuote]);
});

test('un pedido ya pagado, vencido o con reserva modificada conserva la instrucción del servidor sin recotizar', async () => {
  const quote = serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 });
  for (const message of ['El pago inicial ya fue recibido.', 'El intento pendiente venció y requiere revisión.', 'La reserva cambió; actualizá el checkout.']) {
    const { callbacks, paypalStateUpdates } = await paypalCallbacks({
      quote,
      create: async () => { throw Object.assign(new Error(message), { code: 'functions/failed-precondition' }); },
    });
    await assert.rejects(callbacks.createOrder(), { message });
    assert.ok(paypalStateUpdates.some(({ value }) => value === message));
    assert.ok(!paypalStateUpdates.some(({ value }) => typeof value === 'string' && value.includes('volvé a pulsar PayPal')));
  }
});

test('SDK no acepta un ID de creación si el proveedor responde con un importe distinto al mostrado', async () => {
  const quote = serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 });
  const refreshed = serverQuote({ total: 36000, balance: 18000, deposit: 18000, backorder: 36000 });
  const { callbacks } = await paypalCallbacks({
    quote, create: async () => ({ ...refreshed, paypalOrderId: 'PP-DIFFERENT' }), refresh: async () => refreshed,
  });
  await assert.rejects(callbacks.createOrder(), /importe o el tipo de cambio cambió/);
});

test('SDK no se monta con una cotización del backend antiguo ni captura un ID desconocido', async () => {
  const old = await paypalCallbacks({ quote: { crcTotal: 32000, usdTotal: 64 } });
  assert.equal(old.sdkLoads, 0);
  assert.equal(old.callbacks, undefined);
  const { callbacks } = await paypalCallbacks({ quote: serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 }) });
  await callbacks.onApprove({ orderID: 'PP-UNKNOWN' });
  await callbacks.onApprove(undefined);
});

test('una respuesta de captura perdida bloquea nuevas órdenes y recupera exclusivamente el mismo pago', async () => {
  const quote = serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 });
  let creates = 0;
  const captures = [];
  let confirmed;
  const { callbacks, paypalStateUpdates, paypalRefs } = await paypalCallbacks({
    quote,
    create: async () => { creates += 1; return { ...quote, paypalOrderId: 'PP-RECOVER' }; },
    capture: async (data) => {
      captures.push(data);
      if (captures.length === 1) throw new Error('response lost after capture');
      return { result: 'already_paid', partial: true };
    },
    onPaid: (data) => { confirmed = data; },
  });
  await callbacks.createOrder();
  await callbacks.onApprove({ orderID: 'PP-RECOVER' });
  assert.equal(confirmed, undefined);
  assert.ok(paypalStateUpdates.some(({ value }) => typeof value === 'string' && value.includes('Puede haberse cobrado')));
  await assert.rejects(callbacks.createOrder(), /Revisá el pago anterior/);
  assert.equal(creates, 1, 'An unresolved capture must not create a new PayPal order');
  const recovery = paypalStateUpdates.find(({ value }) => value?.paypalOrderId === 'PP-RECOVER').value;
  const latest = paypalRefs.find(({ current }) => typeof current?.confirmPayment === 'function').current;
  await latest.confirmPayment(recovery); // the same callback used by the recovery button
  assert.deepEqual(captures, [
    { orderId: 'local-order', paypalOrderId: 'PP-RECOVER' },
    { orderId: 'local-order', paypalOrderId: 'PP-RECOVER' },
  ]);
  assert.equal(creates, 1);
  assert.equal(confirmed.partial, true);
  assert.equal(confirmed.paypalResult, 'already_paid');
});

test('confirmación PayPal recargada reconoce el apartado recibido y conserva el saldo pendiente', () => {
  const quote = serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 });
  const { html } = renderPage(CONFIRMATION, { savedOrder: {
    orderNumber: 'AP-PP-APARTADO', total: 32000, paymentMethod: 'paypal', paymentStatus: 'parcial',
    paymentAmount: 16000, remainingTotal: 16000, depositStatus: 'pagado', remainingStatus: 'pendiente',
    shippingCost: 0, backorderDeposit: 16000, itemsSummary: [line('bajo_pedido', 32000)], paypal: quote,
  } });
  contains(html, 'Apartado recibido con PayPal.');
  contains(html, `Monto recibido: ${formatCRC(16000)} (apartado 50%)`);
  contains(html, `Saldo pendiente: ${formatCRC(16000)}`);
  contains(html, `Total del pedido: ${formatCRC(32000)}`);
  assert.doesNotMatch(html, /está en revisión/);
  assert.doesNotMatch(html, /data-testid="sinpe-instructions"/);
});

test('confirmación PayPal mantiene el apartado antes de terminar la lectura de Firestore', () => {
  const quote = serverQuote({ total: 62000, balance: 16000, deposit: 16000, backorder: 32000 });
  const { html } = renderPage(CONFIRMATION, { locationState: {
    orderNumber: 'AP-PP-MIXTO', total: 62000, paymentMethod: 'paypal', online: true, paid: true, partial: true, paypalQuote: quote,
  } });
  contains(html, 'Apartado recibido con PayPal.');
  contains(html, `Monto recibido: ${formatCRC(46000)} (apartado 50%)`);
  contains(html, `Saldo pendiente: ${formatCRC(16000)}`);
});

test('confirmación PayPal pendiente no anuncia que el apartado ya fue recibido', () => {
  const quote = serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 });
  const { html } = renderPage(CONFIRMATION, { locationState: {
    orderNumber: 'AP-PP-PENDING', total: 32000, paymentMethod: 'paypal', online: true, paid: false, paypalQuote: quote,
  } });
  contains(html, 'Tu pago con PayPal está en revisión');
  contains(html, `Monto del pago en revisión: ${formatCRC(16000)}`);
  assert.doesNotMatch(html, /Apartado recibido/);
});

test('pedido PayPal antiguo cobrado completo no vuelve a mostrar un saldo del 50%', () => {
  const { html } = renderPage(CONFIRMATION, { savedOrder: {
    orderNumber: 'AP-PP-FULL', total: 32000, paymentMethod: 'paypal', paymentStatus: 'pagado',
    paymentAmount: 32000, remainingTotal: 16000, shippingCost: 0,
    backorderDeposit: 16000, itemsSummary: [line('bajo_pedido', 32000)],
    paypal: { crcTotal: 32000, usdTotal: 64 },
  } });
  contains(html, `Monto recibido: ${formatCRC(32000)}`);
  contains(html, `Saldo pendiente: ${formatCRC(0)}`);
  assert.doesNotMatch(html, /apartado 50%/);
});


test('confirmación y WhatsApp conservan el apartado guardado del 25% en pedidos anteriores', () => {
  for (const field of ['backorderDeposit', 'depositTotal']) {
    const { html } = renderPage(CONFIRMATION, { savedOrder: {
      orderNumber: 'AP-ANTERIOR', total: 47000, paymentMethod: 'sinpe', shippingCost: 0,
      itemsSummary: [line('bajo_pedido', 47000)], [field]: 11750,
    }, locationState: { backorder: {
      hasBackorder: true, total: 47000, backorderSubtotal: 47000,
      depositTotal: 23500, balanceDue: 23500, payNowTotal: 23500,
    } } });
    contains(html, `Monto a pagar ahora (apartado) ${formatCRC(11750)}`);
    contains(html, `Saldo restante: ${formatCRC(35250)}`);
    contains(html, '25% de los productos bajo pedido');
    assert.doesNotMatch(html, /50%/);
    const href = html.match(/href="(https:\/\/wa\.me\/[^"]+)"/)[1].replace(/&amp;/g, '&');
    const message = new URL(href).searchParams.get('text');
    assert.ok(message.includes(formatCRC(11750)));
    assert.ok(message.includes('25% de los productos bajo pedido'));
    assert.ok(message.includes('AP-ANTERIOR'));
  }
});

test('confirmación de stock no aplica el apartado del 50%', () => {
  const { html } = renderPage(CONFIRMATION, { savedOrder: {
    orderNumber: 'AP-STOCK', total: 30000, paymentMethod: 'sinpe', shippingCost: 0,
    itemsSummary: [line('stock_propio', 30000)], backorderDeposit: 0,
  } });
  contains(html, `Monto a pagar ${formatCRC(30000)}`);
  assert.doesNotMatch(html, /data-testid="deposit-detail"/);
  assert.doesNotMatch(html, /50%/);
});
