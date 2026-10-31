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
import { tilopayQuoteKey } from '../src/services/payments/tilopayQuote.js';
import { GIVEAWAY_PHONE_ERROR } from '../functions/lib/giveawayPhone.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const CHECKOUT = 'src/pages/store/CheckoutPage.jsx';
const CART = 'src/components/storefront/CartDrawer.jsx';
const CONFIRMATION = 'src/pages/store/OrderConfirmation.jsx';
const PAYPAL_PANEL = 'src/components/payments/PaypalPanel.jsx';
const PRODUCT = 'src/pages/store/ProductPage.jsx';
const WHATSAPP = 'src/components/storefront/WhatsAppButton.jsx';
const SHIPPING = 'src/services/shippingService.js';
const LEGAL = 'src/pages/store/LegalPages.jsx';
const realFiles = [
  CHECKOUT, CART, CONFIRMATION, PAYPAL_PANEL, PRODUCT, WHATSAPP, SHIPPING, LEGAL,
  'src/utils/backorder.js', 'src/utils/constants.js', 'src/utils/formatters.js',
  'src/services/payments/registry.js', 'src/data/costaRicaTerritorial.js',
  'functions/lib/costaRicaTerritorial.mjs',
  'src/components/ui/CopyButton.jsx', 'src/components/ui/LoadingSpinner.jsx',
  'src/services/payments/paypalQuote.js', 'src/services/payments/tilopayQuote.js',
  'src/components/ui/StatusBadge.jsx', 'src/utils/shippingText.js',
  'src/utils/shippingDelivery.js', 'src/utils/productPrice.js', 'src/hooks/usePageTitle.js',
  'functions/lib/catalogPrice.mjs',
  'functions/lib/giveawayPhone.mjs',
  'src/components/legal/LegalLayout.jsx',
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
  const availability = { ...(options.paypalAvailable ? { paypal: { available: true } } : {}),
    ...(options.tilopayAvailable ? { tilopay: { available: true } } : {}) };
  const paypalTotals = [];
  const paypalEffects = [];
  const paypalRefs = [];
  const paypalStateUpdates = [];
  const paypalProps = [];
  const checkoutEffects = [];
  const checkoutStateUpdates = [];
  const checkoutStates = [];
  const checkoutElements = [];
  const titleEffects = [];
  const navigations = [];
  const cache = new Map();
  const abs = (name) => path.join(root, name);
  const user = Object.hasOwn(options, 'user') ? options.user
    : { uid: 'render-test-user', displayName: 'Ana Prueba', email: 'ana@example.invalid', isAnonymous: false };
  const paypalProvider = {
    id: 'paypal', kind: 'online', label: 'PayPal / Tarjeta',
    getAvailability: options.allowCheckoutEffects ? async () => ({ available: Boolean(options.paypalAvailable) }) : forbidden('PayPal availability'),
    Panel: (props) => {
      paypalProps.push(props);
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
      addItem: forbidden('add to cart'),
      clearCart: options.clearCart || forbidden('cart clear'), removeItem: forbidden('item removal'), updateQuantity: forbidden('quantity change'),
    }) }],
    [abs('src/firebase.js'), { db: {} }],
    [abs('src/services/orderService.js'), { createOrder: options.createOrder || forbidden('order creation') }],
    [abs('src/services/payments/cashOnDeliveryClient.js'), {
      createCashOnDeliveryOrder: options.createCashOnDeliveryOrder || forbidden('cash-on-delivery order creation'),
    }],
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
      getAvailability: options.allowCheckoutEffects ? async () => ({ available: Boolean(options.tilopayAvailable) }) : forbidden('Tilopay availability'),
      Panel: () => React.createElement('div', { 'data-testid': 'tilopay-panel' }),
    } }],
    [abs('src/components/auth/SaveAccountPrompt.js'), { __esModule: true, default: () => null }],
  ]);
  if (options.realShipping) modules.delete(abs(SHIPPING));

  // SSR does not run effects. Seed the form, loaded availability and saved order
  // as initial state, while delegating every hook to the real React dispatcher.
  // This exercises the actual render branches; it does not test auth/SDK effects.
  let checkoutStateSlot = 0;
  const checkoutReact = {
    ...React,
    useEffect(effect, dependencies) {
      checkoutEffects.push(effect);
      return React.useEffect(effect, dependencies);
    },
    useState(initial) {
      const slot = checkoutStateSlot++;
      let value = initial;
      if (initial && typeof initial === 'object' && Object.hasOwn(initial, 'paymentMethod')) {
        value = { ...initial, paymentMethod: options.paymentMethod ?? 'sinpe',
          provincia: options.provincia || 'Alajuela', canton: options.canton || 'Grecia', distrito: 'Grecia',
          ...options.form };
      }
      if (slot === 2 && options.errors) value = options.errors;
      if (slot === 4) {
        assert.deepEqual(initial, {}, 'Update availability fixture if CheckoutPage state layout changes');
        value = availability;
      }
      if (slot === 5) {
        assert.equal(initial, null, 'Update quote fixture if CheckoutPage state layout changes');
        value = options.paypalQuote ? { key: paypalQuoteKey(items, 'Grecia', 'normal'), quote: options.paypalQuote } : null;
      }
      if (slot === 6) {
        assert.equal(initial, null, 'Update Tilopay quote fixture if CheckoutPage state layout changes');
        value = options.tilopayQuote ? { uid: user?.uid, key: tilopayQuoteKey(items, 'Grecia', 'normal'),
          quote: options.tilopayQuote, ...options.tilopayQuotedRecord } : null;
      }
      const [state, setState] = React.useState(value);
      checkoutStates[slot] = state;
      return [state, (next) => {
        const resolved = typeof next === 'function' ? next(checkoutStates[slot]) : next;
        checkoutStateUpdates.push({ slot, value: resolved });
        checkoutStates[slot] = resolved;
        setState(next);
      }];
    },
  };
  const confirmationReact = {
    ...React,
    useState(initial) {
      return React.useState(initial === null && options.savedOrder ? options.savedOrder : initial);
    },
  };
  const variant = { id: '100ml', name: '100 ml', price: 47000,
    commercialStatus: 'disponible', supplyType: 'stock_propio', active: true, ...options.variant };
  const productStates = [
    { id: 'versace-eros', name: 'Versace Eros EDT 100 ml', basePrice: 47000, images: [], ...options.product },
    [variant], variant, 1, false, false, 0,
  ];
  let productStateSlot = 0;
  const productReact = { ...React, useState() { return React.useState(productStates[productStateSlot++]); } };
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
      if (name === 'react' && filename === abs('src/hooks/usePageTitle.js')) return {
        ...React,
        useEffect(effect, dependencies) { titleEffects.push(effect); return React.useEffect(effect, dependencies); },
      };
      if (name === 'react') return filename === abs(CHECKOUT) ? checkoutReact
        : filename === abs(CONFIRMATION) ? confirmationReact : filename === abs(PAYPAL_PANEL) ? paypalReact
          : filename === abs(PRODUCT) ? productReact : React;
      if (name === 'react/jsx-runtime' && filename === abs(CHECKOUT)) {
        const runtime = require(name);
        const capture = (original) => (type, props, ...rest) => {
          checkoutElements.push({ type, props });
          return original(type, props, ...rest);
        };
        return { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) };
      }
      if (name === 'react-router-dom' && filename === abs(CHECKOUT)) return {
        ...require(name), useNavigate: () => (...args) => navigations.push(args),
      };
      if (['react/jsx-runtime', 'react-router-dom', 'lucide-react'].includes(name)) return require(name);
      if (name === 'firebase/firestore') return {
        ...Object.fromEntries(['doc', 'getDoc', 'collection', 'getDocs', 'onSnapshot'].map((name) => [name, forbidden(`Firestore ${name}`)])),
        ...(filename === abs(CHECKOUT) && options.allowCheckoutEffects ? {
          doc: (_db, collection, id) => ({ collection, id }),
          getDoc: async () => ({ exists: () => Boolean(options.crmData), data: () => options.crmData }),
        } : {}),
      };
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

  const Component = load(abs(relative))[options.exportName || 'default'];
  const confirmation = relative === CONFIRMATION;
  const product = relative === PRODUCT;
  const defaultPath = confirmation ? '/orden-confirmada/order-render' : product ? '/producto/versace-eros' : '/checkout';
  const location = new URL(options.url || defaultPath, 'https://render.example.invalid');
  const routePath = confirmation ? '/orden-confirmada/:orderId' : product ? '/producto/:productId' : '*';
  const element = React.createElement(React.Fragment, null,
    React.createElement(Component, options.componentProps),
    options.withWhatsapp ? React.createElement(load(abs(WHATSAPP)).default) : null);
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, {
    initialEntries: [{ pathname: location.pathname, search: location.search, hash: location.hash, state: options.locationState || null }],
  }, React.createElement(Routes, null, React.createElement(Route, {
    path: routePath, element,
  }))));
  return { html, paypalTotals, paypalEffects, paypalRefs, paypalStateUpdates, paypalProps,
    checkoutEffects, checkoutStateUpdates, checkoutStates, checkoutElements, titleEffects, navigations };
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

test('Tilopay espera la cotización del servidor y no presenta un importe local como cobro', () => {
  const { html } = renderPage(CHECKOUT, { items: [line('bajo_pedido', 32000)],
    tilopayAvailable: true, paymentMethod: 'tilopay' });
  assert.match(html, /data-testid="tilopay-panel"/);
  contains(html, 'Calculando…');
  contains(html, 'El servidor confirmará el monto a pagar ahora y el saldo antes de habilitar el pago con tarjeta.');
  assert.doesNotMatch(html, /data-testid="deposit-summary"|type="submit"/);
  assert.ok(!text(html).includes(`Pagás ahora ${formatCRC(16000)}`));
});

test('Tilopay resume el total y el apartado del servidor para stock, Bajo pedido y mixto', () => {
  for (const scenario of [
    { items: [line('stock_propio', 31000)], total: 35000, balance: 0, deposit: 0, backorder: 0 },
    { items: [line('bajo_pedido', 31000)], total: 35000, balance: 16000, deposit: 16000, backorder: 32000 },
    { items: [line('stock_propio', 29000), line('bajo_pedido', 31000)], total: 65000, balance: 16000, deposit: 16000, backorder: 32000 },
  ]) {
    const quote = { ...serverQuote({ ...scenario, shipping: 3000 }), currency: 'CRC' };
    const { html } = renderPage(CHECKOUT, { items: scenario.items, shippingCost: 3000,
      tilopayAvailable: true, paymentMethod: 'tilopay', tilopayQuote: quote });
    contains(html, `Pagás ahora ${formatCRC(quote.crcPayNow)}${scenario.balance ? ' (apartado 50%)' : ''}`);
    contains(html, formatCRC(quote.crcTotal));
    if (scenario.balance) contains(html, `Saldo restante ${formatCRC(scenario.balance)}`);
    else assert.doesNotMatch(html, /data-testid="deposit-summary"/);
    assert.doesNotMatch(html, /type="submit"/);
  }
});

test('Tilopay oculta cotizaciones de otro carrito, envío o usuario incluso antes del efecto de recarga', () => {
  const items = [line('bajo_pedido', 32000)];
  const quote = { ...serverQuote({ total: 35000, shipping: 3000, balance: 16000, deposit: 16000, backorder: 32000 }), currency: 'CRC' };
  for (const tilopayQuotedRecord of [
    { key: tilopayQuoteKey([line('bajo_pedido', 32000, 'otro')], 'Grecia', 'normal') },
    { key: tilopayQuoteKey(items, 'San José', 'normal') },
    { key: tilopayQuoteKey(items, 'Grecia', 'express') },
    { uid: 'otro-usuario' },
    { quote: { ...quote, crcPayNow: 1 } },
  ]) {
    const { html } = renderPage(CHECKOUT, { items, tilopayAvailable: true, paymentMethod: 'tilopay',
      tilopayQuote: quote, tilopayQuotedRecord });
    contains(html, 'Calculando…');
    assert.doesNotMatch(html, /data-testid="deposit-summary"/);
    assert.ok(!text(html).includes(`Pagás ahora ${formatCRC(19000)}`));
  }
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

test('PayPal elegido explícitamente muestra apartado más stock y envío del servidor en el pedido mixto', () => {
  const { html, paypalTotals } = renderPage(CHECKOUT, {
    items: [line('stock_propio', 30000), line('bajo_pedido', 10000)], shippingCost: 5000,
    paypalAvailable: true, paymentMethod: 'paypal',
    paypalQuote: serverQuote({ total: 45000, balance: 5000, deposit: 5000, backorder: 10000, shipping: 5000 }),
  });
  assert.doesNotMatch(html, /Recomendado/);
  contains(html, 'Pagá con PayPal y comprás protegido');
  assert.ok(html.indexOf('value="sinpe"') < html.indexOf('value="paypal"'));
  assert.deepEqual(paypalTotals, [45000]);
  assert.match(html, /data-testid="paypal-panel"/);
  assert.match(html, /data-testid="deposit-summary"/);
  contains(html, `Pagás ahora ${formatCRC(40000)} (apartado 50%)`);
  contains(html, `Total del pedido: ${formatCRC(45000)}`);
  contains(html, `Saldo pendiente: ${formatCRC(5000)}`);
  contains(html, 'Cobro de hoy en PayPal: US$ 80.00');
  assert.doesNotMatch(html, /type="submit"/);
});

test('seleccionar SINPE o transferencia oculta la promoción y el panel PayPal, aunque PayPal siga disponible', () => {
  for (const paymentMethod of ['sinpe', 'transferencia']) {
    const { html, paypalTotals } = renderPage(CHECKOUT, {
      items: [line('stock_propio', 30000)], paypalAvailable: true, paymentMethod,
    });
    assert.match(html, /value="paypal"/);
    assert.doesNotMatch(html, /Recomendado/);
    assert.doesNotMatch(html, /data-testid="paypal-trust-note"|data-testid="paypal-panel"/);
    assert.doesNotMatch(html, /Pagá con PayPal y comprás protegido/);
    assert.deepEqual(paypalTotals, []);
    assert.match(html, /type="submit"/);
  }
});

test('cada checkout comienza sin método preseleccionado y sin distintivo recomendado', async () => {
  const page = renderPage(CHECKOUT, {
    items: [line('stock_propio', 30000)], paypalAvailable: true, paymentMethod: '',
    allowCheckoutEffects: true,
    crmData: { displayName: 'Cliente recurrente', preferredPaymentMethod: 'paypal' },
  });
  const paymentInputs = [...page.html.matchAll(/<input\b[^>]*name="payment"[^>]*>/g)].map(([tag]) => tag);
  assert.equal(paymentInputs.length, 4);
  assert.ok(paymentInputs.every((tag) => !/\bchecked/.test(tag)));
  contains(page.html, 'Elegí cómo querés pagar este pedido.');
  assert.doesNotMatch(page.html, /Recomendado|data-testid="paypal-trust-note"|data-testid="paypal-panel"/);
  const cleanups = page.checkoutEffects.map((effect) => effect());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(page.checkoutStates[1].name, 'Cliente recurrente', 'The actual CRM prefill effect ran');
  assert.equal(page.checkoutStates[4].paypal.available, true, 'The gateway availability effect ran');
  assert.equal(page.checkoutStates[1].paymentMethod, '', 'Availability and CRM cannot make a payment choice');
  cleanups.forEach((cleanup) => cleanup?.());
});

test('el formulario exige elegir un método y el radio registra la decisión explícita', async () => {
  const page = renderPage(CHECKOUT, { items: [line('stock_propio', 30000)], paymentMethod: '', paypalAvailable: true });
  await page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(page.checkoutStates[2].paymentMethod, 'Selecciona método de pago');
  const paypalRadio = page.checkoutElements.find(({ type, props }) => type === 'input' && props.name === 'payment' && props.value === 'paypal');
  paypalRadio.props.onChange();
  assert.equal(page.checkoutStates[1].paymentMethod, 'paypal');
});

test('checkout aplica su título aun con carrito vacío y restaura el anterior al salir', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { title: 'Página anterior' };
  try {
    for (const items of [[], [line('stock_propio', 30000)]]) {
      const page = renderPage(CHECKOUT, { items });
      assert.equal(page.titleEffects.length, 1);
      const cleanup = page.titleEffects[0]();
      assert.equal(document.title, 'Checkout | Aquí Pauli');
      cleanup();
      assert.equal(document.title, 'Página anterior');
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
});

const validCheckoutForm = {
  name: 'Ana Prueba', email: 'ana@example.invalid', phone: '88888888',
  provincia: 'Alajuela', canton: 'Grecia', distrito: 'Grecia', señas: 'Dirección ficticia de prueba', paymentPhone: '88888888',
};

test('el checkout de tarjeta guarda el código del distrito aunque la dirección guardada no lo tenga', async () => {
  let order;
  const page = renderPage(CHECKOUT, {
    items: [line('stock_propio', 1000)], paymentMethod: 'tilopay', tilopayAvailable: true,
    form: { ...validCheckoutForm, distrito: 'Tacares', codigoPostal: '' },
    createOrder: async data => { order = data; return { orderId: 'postal-test' }; },
  });
  const { props } = page.checkoutElements.find(element => typeof element.props.createPendingOrder === 'function');
  assert.equal(props.validateForm(), true);
  await props.createPendingOrder('tilopay');
  assert.equal(order.shippingAddress.codigoPostal, '20305');
});

test('contra entrega aparece solo en carritos compuestos enteramente por stock conocido', () => {
  for (const items of [[line('stock_propio', 30000)], [line('stock_propio', 30000, 'p1'), line('stock_propio', 22000, 'p2')]]) {
    const { html } = renderPage(CHECKOUT, { items, paymentMethod: '', paypalAvailable: true });
    assert.match(html, /name="payment"[^>]*value="contra_entrega"/);
    contains(html, 'Contra entrega (efectivo)');
    assert.doesNotMatch(html, /name="payment"[^>]*checked/);
    assert.match(html, /value="sinpe"/);
    assert.match(html, /value="transferencia"/);
    assert.match(html, /value="paypal"/);
  }
  for (const items of [[], [line('bajo_pedido', 32000)],
    [line('stock_propio', 30000), line('bajo_pedido', 32000)], [line(undefined, 30000)], [line('otro', 30000)]]) {
    const { html } = renderPage(CHECKOUT, { items, paymentMethod: '' });
    assert.doesNotMatch(html, /name="payment"[^>]*value="contra_entrega"/);
    if (items.length) contains(html, 'Contra entrega solo está disponible para pedidos con todos sus productos en stock.');
  }
});

test('contra entrega anuncia cero adelanto y el total al recibir, sin pago online ni comprobante', () => {
  const { html, paypalTotals } = renderPage(CHECKOUT, {
    items: [line('stock_propio', 52000)], paymentMethod: 'contra_entrega', paypalAvailable: true,
  });
  contains(html, `Pagás ahora ${formatCRC(0)}`);
  contains(html, `Pagás al recibir ${formatCRC(52000)}`);
  contains(html, 'Pagás el total en efectivo al recibir tu pedido.');
  contains(html, 'Confirmar pedido contra entrega');
  assert.match(html, /data-testid="cash-on-delivery-summary"/);
  assert.doesNotMatch(html, /data-testid="deposit-summary"|data-testid="paypal-panel"|data-testid="paypal-trust-note"/);
  assert.doesNotMatch(html, /Teléfono SINPE|Datos para transferencia/);
  assert.deepEqual(paypalTotals, []);
});

test('invitado confirma contra entrega por el servicio canónico y muestra el total devuelto por el servidor', async () => {
  const calls = [];
  let cleared = 0;
  const page = renderPage(CHECKOUT, {
    items: [line('stock_propio', 30000)], paymentMethod: 'contra_entrega',
    user: { uid: 'anonymous-owner', isAnonymous: true },
    form: { ...validCheckoutForm, paymentPhone: '', customerNotes: '  Llamar al llegar.  ' },
    createCashOnDeliveryOrder: async data => {
      calls.push(data);
      return { orderId: 'cod-server', orderNumber: 'AP-COD', total: 32000, amountDueOnDelivery: 32000 };
    },
    clearCart: () => { cleared++; },
  });
  await page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].paymentMethod, 'contra_entrega');
  assert.equal(calls[0].customerNotes, 'Llamar al llegar.');
  assert.equal(calls[0].isGuest, true);
  assert.equal(cleared, 1);
  assert.deepEqual(page.navigations, [['/orden-confirmada/cod-server', { state: {
    orderNumber: 'AP-COD', total: 32000, paymentMethod: 'contra_entrega', customerNotes: 'Llamar al llegar.',
    paid: false, online: false, paymentStatus: 'pendiente', amountDueOnDelivery: 32000,
  } }]]);
});

test('una selección de contra entrega queda invalidada al encontrar Bajo pedido sin esperar efectos', async () => {
  const page = renderPage(CHECKOUT, {
    items: [line('stock_propio', 30000), line('bajo_pedido', 32000)],
    paymentMethod: 'contra_entrega', form: validCheckoutForm, allowCheckoutEffects: true,
    user: { uid: 'anonymous-owner', isAnonymous: true },
  });
  await page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit({ preventDefault() {} });
  assert.match(page.checkoutStates[2].paymentMethod, /todos los productos están en stock/);
  assert.equal(page.navigations.length, 0);
  assert.doesNotMatch(page.html, /data-testid="cash-on-delivery-summary"/);
  assert.doesNotMatch(page.html, /name="payment"[^>]*checked/);
  contains(page.html, 'La selección de contra entrega dejó de ser válida porque el carrito cambió.');
  contains(page.html, `Apartá con ${formatCRC(46000)} (50%)`);
  assert.equal(page.checkoutStates[1].paymentMethod, '');
  assert.match(page.checkoutStates[2].paymentMethod, /Elegí otro método de pago/);
});

test('doble toque de confirmar contra entrega reutiliza la petición en curso y no duplica reservas', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  let calls = 0;
  let cleared = 0;
  const page = renderPage(CHECKOUT, {
    items: [line('stock_propio', 52000)], paymentMethod: 'contra_entrega', form: validCheckoutForm,
    createCashOnDeliveryOrder: () => { calls++; return pending; }, clearCart: () => { cleared++; },
  });
  const submit = page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit;
  const first = submit({ preventDefault() {} });
  await submit({ preventDefault() {} });
  assert.equal(calls, 1);
  assert.equal(cleared, 0);
  resolve({ orderId: 'single-cod', orderNumber: 'AP-COD-ONE', total: 52000, amountDueOnDelivery: 52000 });
  await first;
  assert.equal(cleared, 1);
  assert.equal(page.navigations.length, 1);
});

test('si el catálogo rechaza contra entrega, conserva el carrito y muestra el error del servidor', async () => {
  const page = renderPage(CHECKOUT, {
    items: [line('stock_propio', 52000)], paymentMethod: 'contra_entrega', form: validCheckoutForm,
    createCashOnDeliveryOrder: async () => {
      throw Object.assign(new Error('Contra entrega no está disponible: el producto cambió a Bajo pedido.'), { code: 'functions/failed-precondition' });
    },
  });
  await page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(page.navigations.length, 0);
  assert.match(page.checkoutStates[2].submit, /producto cambió a Bajo pedido/);
  assert.equal(page.checkoutStates[3], false);
});

test('contra entrega acepta teléfono local y prefijo de Costa Rica sin exigir número SINPE', async () => {
  for (const phone of ['83100015', '+506 8310-0015', '506 8310 0015', '50612345']) {
    const calls = [];
    const page = renderPage(CHECKOUT, {
      items: [line('stock_propio', 52000)], paymentMethod: 'contra_entrega',
      form: { ...validCheckoutForm, phone, paymentPhone: '' }, clearCart() {},
      createCashOnDeliveryOrder: async data => {
        calls.push(data);
        return { orderId: 'cod-phone', orderNumber: 'AP-PHONE', total: 52000, amountDueOnDelivery: 52000 };
      },
    });
    await page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit({ preventDefault() {} });
    assert.equal(calls.length, 1);
    assert.equal(page.navigations.length, 1);
    assert.equal(page.checkoutStates[2].phone, undefined);
    assert.equal(page.checkoutStates[1].phone, phone, 'El texto del campo no se recorta silenciosamente');
  }
});

test('teléfono COD de diez dígitos o prefijo repetido se rechaza antes del servicio con error asociado al campo', async () => {
  for (const phone of ['8310001512', '+5068310001512', '+50650683100015', '18310001', '8310ABC5']) {
    let calls = 0;
    const options = { items: [line('stock_propio', 52000)], paymentMethod: 'contra_entrega',
      form: { ...validCheckoutForm, phone }, createCashOnDeliveryOrder: async () => { calls++; } };
    const page = renderPage(CHECKOUT, options);
    await page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit({ preventDefault() {} });
    assert.equal(calls, 0);
    assert.equal(page.navigations.length, 0);
    assert.equal(page.checkoutStates[2].phone, GIVEAWAY_PHONE_ERROR);
    assert.equal(page.checkoutStates[1].phone, phone);
    const errorPage = renderPage(CHECKOUT, { ...options, errors: page.checkoutStates[2] });
    contains(errorPage.html, GIVEAWAY_PHONE_ERROR);
    assert.match(errorPage.html, /id="checkout-phone-error" role="alert"/);
    const input = errorPage.checkoutElements.find(({ type, props }) => type === 'input' && props.id === 'checkout-phone');
    assert.equal(input.props['aria-invalid'], true);
    assert.equal(input.props['aria-describedby'], 'checkout-phone-error');
    assert.equal(input.props.maxLength, undefined, 'No limitar el campo antes de poder explicar el error');
  }
});

test('la validación de teléfono de otros métodos conserva el comportamiento existente', async () => {
  for (const paymentMethod of ['sinpe', 'transferencia']) {
    let calls = 0;
    const page = renderPage(CHECKOUT, {
      items: [line('stock_propio', 52000)], paymentMethod, form: { ...validCheckoutForm, phone: '1234567890' }, clearCart() {},
      createOrder: async () => { calls++; return { orderId: 'manual-phone', orderNumber: 'AP-MANUAL' }; },
    });
    await page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit({ preventDefault() {} });
    assert.equal(calls, 1);
    assert.equal(page.checkoutStates[2].phone, undefined);
  }
});

test('COD presenta invalid-argument públicos conocidos y oculta mensajes internos desconocidos', async () => {
  for (const message of [GIVEAWAY_PHONE_ERROR,
    'Ingresá tu nombre completo para coordinar la entrega.',
    'Ingresá un correo válido para coordinar la entrega.',
    'Completá provincia, cantón, distrito y señas exactas para la entrega.',
    'Internal detail: credential=DO-NOT-DISPLAY']) {
    const page = renderPage(CHECKOUT, {
      items: [line('stock_propio', 52000)], paymentMethod: 'contra_entrega', form: validCheckoutForm,
      createCashOnDeliveryOrder: async () => { throw Object.assign(new Error(message), { code: 'functions/invalid-argument' }); },
    });
    await page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit({ preventDefault() {} });
    assert.equal(page.navigations.length, 0);
    assert.equal(page.checkoutStates[2].submit, message.startsWith('Internal detail:')
      ? 'Revisá tu nombre, teléfono, correo y dirección de entrega e intentá de nuevo.' : message);
    assert.doesNotMatch(page.checkoutStates[2].submit, /DO-NOT-DISPLAY/);
    if (message === GIVEAWAY_PHONE_ERROR) assert.equal(page.checkoutStates[2].phone, GIVEAWAY_PHONE_ERROR);
  }
});

test('las notas opcionales muestran límite y descripción accesible sin recortar texto por código', () => {
  const page = renderPage(CHECKOUT, { items: [line('stock_propio', 30000)], form: { customerNotes: 'Llamar antes.' } });
  contains(page.html, 'Notas del pedido (opcional)');
  contains(page.html, '13/1000 caracteres');
  const notes = page.checkoutElements.find(({ type, props }) => type === 'textarea' && props.id === 'checkout-customer-notes');
  assert.equal(notes.props.maxLength, 1000);
  assert.ok(!notes.props.required);
  assert.equal(notes.props['aria-invalid'], false);
  assert.match(notes.props['aria-describedby'], /checkout-customer-notes-help/);
  notes.props.onChange({ target: { value: 'a'.repeat(1001) } });
  assert.equal(page.checkoutStates[1].customerNotes.length, 1001, 'An injected excessive value is kept for validation instead of silently truncated');
});

test('el envío manual conserva las notas del cliente, incluidas vacías y el límite de 1000', async () => {
  for (const customerNotes of ['', '   ', '  Llamar antes de entregar.  ', 'a'.repeat(1000)]) {
    const calls = [];
    let cleared = 0;
    const page = renderPage(CHECKOUT, {
      items: [line('stock_propio', 30000)], paymentMethod: 'sinpe', form: { ...validCheckoutForm, customerNotes },
      createOrder: async (data) => { calls.push(data); return { orderId: 'notes-test', orderNumber: 'AP-NOTES' }; },
      clearCart: () => { cleared += 1; },
    });
    await page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit({ preventDefault() {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].customerNotes, customerNotes.trim());
    assert.ok(!Object.hasOwn(calls[0], 'notes'), 'Customer notes stay separate from internal admin notes');
    assert.equal(cleared, 1);
    assert.equal(page.navigations[0][0], '/orden-confirmada/notes-test');
    assert.equal(page.navigations[0][1].state.customerNotes, customerNotes.trim());
  }
});

test('notas mayores a 1000 impiden crear el pedido y muestran un error asociado al campo', async () => {
  const options = { items: [line('stock_propio', 30000)], form: { ...validCheckoutForm, customerNotes: 'a'.repeat(1001) } };
  const page = renderPage(CHECKOUT, options);
  await page.checkoutElements.find(({ type }) => type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(page.checkoutStates[2].customerNotes, 'Las notas pueden tener hasta 1000 caracteres.');
  const invalid = renderPage(CHECKOUT, { ...options, errors: page.checkoutStates[2] });
  assert.match(invalid.html, /id="checkout-customer-notes-error" role="alert"/);
  const notes = invalid.checkoutElements.find(({ type, props }) => type === 'textarea' && props.id === 'checkout-customer-notes');
  assert.equal(notes.props['aria-invalid'], true);
  assert.match(notes.props['aria-describedby'], /checkout-customer-notes-error/);
});

test('el pedido pendiente de PayPal recibe las mismas notas opcionales del checkout', async () => {
  const calls = [];
  const page = renderPage(CHECKOUT, {
    items: [line('stock_propio', 30000)], paypalAvailable: true, paymentMethod: 'paypal',
    paypalQuote: serverQuote({ total: 30000 }), form: { ...validCheckoutForm, customerNotes: '  Envolver para regalo.  ' },
    paypalClient: { createPaypalPendingOrder: async (data) => { calls.push(data); return { orderId: 'paypal-notes', orderNumber: 'AP-NOTES-PP' }; } },
    clearCart() {},
  });
  assert.equal(page.paypalProps[0].validateForm(), true);
  await page.paypalProps[0].createPendingOrder('paypal');
  assert.equal(calls[0].customerNotes, 'Envolver para regalo.');
  assert.equal(calls[0].paymentMethod, 'paypal');
  assert.ok(!Object.hasOwn(calls[0], 'notes'));
  page.paypalProps[0].onPaid({ orderId: 'paypal-notes', orderNumber: 'AP-NOTES-PP', paypalResult: 'captured' });
  assert.equal(page.navigations[0][1].state.customerNotes, 'Envolver para regalo.');
  page.paypalProps[0].onPaid({ orderId: 'another-pending-order', orderNumber: 'AP-OTHER', paypalResult: 'captured' });
  assert.equal(page.navigations[1][1].state.customerNotes, undefined, 'Never show notes from a different pending order');
});

test('la cédula se presenta como opcional y tiene una etiqueta asociada sin required', () => {
  const { html } = renderPage(CHECKOUT, { items: [line('stock_propio', 30000)] });
  assert.match(html, /<label[^>]*for="checkout-cedula"[^>]*>Cédula \(opcional\)<\/label>/);
  const input = html.match(/<input\b[^>]*id="checkout-cedula"[^>]*>/)?.[0];
  assert.ok(input);
  assert.doesNotMatch(input, /\brequired\b/);
});

test('checkout y envíos publican los mismos plazos por zona y la condición de express', () => {
  const policies = renderPage(LEGAL, { exportName: 'EnviosPage', url: '/envios' }).html;
  for (const [canton, provincia, expected, express] of [
    ['San José', 'San José', '2-4 días hábiles', false],
    ['Liberia', 'Guanacaste', '4-7 días hábiles', false],
    ['Grecia', 'Alajuela', '2-4 días hábiles', true],
  ]) {
    const checkout = renderPage(CHECKOUT, {
      items: [line('stock_propio', 30000)], canton, provincia, realShipping: true,
    }).html;
    contains(checkout, expected);
    contains(checkout, 'Mensajería local o Correos de Costa Rica, según tu zona.');
    assert.doesNotMatch(checkout, /Envío Normal \(Correos de Costa Rica\)/);
    contains(policies, expected);
    assert.equal(/value="express"/.test(checkout), express);
    if (express) {
      contains(checkout, '1-2 días hábiles, cuando esté disponible');
      contains(policies, '1-2 días hábiles, cuando esté disponible');
    }
  }
});

test('las políticas reflejan los medios de pago disponibles y el apartado solo de líneas Bajo pedido', () => {
  const shipping = renderPage(LEGAL, { exportName: 'EnviosPage', url: '/envios' }).html;
  const terms = renderPage(LEGAL, { exportName: 'TerminosPage', url: '/terminos' }).html;
  const returns = renderPage(LEGAL, { exportName: 'DevolucionesPage', url: '/devoluciones' }).html;
  contains(shipping, 'Si todos los productos están en stock, podés elegir contra entrega en efectivo');
  contains(shipping, 'pagás el monto completo al recibir, sin adelanto');
  contains(terms, 'Contra entrega en efectivo: disponible cuando todos los productos del pedido están en stock');
  contains(shipping, 'Si tu pedido incluye productos Bajo pedido, no se ofrece contra entrega.');
  contains(shipping, 'el 50% de esas líneas y el importe completo de las líneas en stock');
  assert.doesNotMatch(text(shipping), /El pago contra entrega, en efectivo o por SINPE Móvil, no está disponible/);
  assert.doesNotMatch(text(terms), /El pago contra entrega no está disponible para los pedidos realizados en la tienda en línea/);
  assert.doesNotMatch(text(returns), /Pago contra entrega: el reembolso/);
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

// SSR verifies the actual responsive DOM contract, route matching and drawer
// state. It does not measure browser pixels or pretend to emulate a mobile viewport.
function classesIn(tag) {
  assert.ok(tag, 'Expected rendered element');
  return new Set((tag.match(/\bclass="([^"]*)"/)?.[1] || '').split(/\s+/));
}

function floatingWhatsappClasses(html) {
  const tag = html.match(/<a\b[^>]*aria-label="Chatea con nosotros por WhatsApp"[^>]*>/)?.[0];
  assert.ok(tag, 'The real floating WhatsApp component must render its accessible link');
  assert.match(tag, /href="https:\/\/wa\.me\/50671613342\?text=/);
  return classesIn(tag);
}

function assertMobileHidden(html) {
  const classes = floatingWhatsappClasses(html);
  assert.ok(classes.has('hidden'), 'The floating link must not cover mobile purchase controls');
  assert.ok(classes.has('lg:block'), 'Desktop retains the floating link; mobile landscape stays protected');
}

for (const url of ['/', '/?categoria=perfumes', '/catalogo', '/catalogo/?marca=versace',
  '/producto/versace-eros', '/producto/versace-eros/?variante=100ml#comprar',
  '/checkout', '/checkout/?metodo=paypal', '/carrito', '/carrito/']) {
  test(`WhatsApp se oculta solo en móvil en la ruta de compra ${url}`, () => {
    assertMobileHidden(renderPage(WHATSAPP, { url }).html);
  });
}

test('WhatsApp sigue visible en rutas sin tarjetas o controles de compra', () => {
  for (const url of ['/terminos', '/orden-confirmada/AP-1', '/checkout-ayuda']) {
    const classes = floatingWhatsappClasses(renderPage(WHATSAPP, { url }).html);
    assert.ok(classes.has('block'), `WhatsApp remains visible on ${url}`);
    assert.ok(!classes.has('hidden'), `A non-purchase route must not hide WhatsApp: ${url}`);
  }
});

test('el carrito oculta WhatsApp móvil y al cerrarlo respeta la visibilidad de la ruta', () => {
  for (const url of ['/', '/catalogo', '/terminos']) {
    const open = renderPage(CART, { url, cartOpen: true, items: [line('stock_propio', 47000)], withWhatsapp: true });
    assertMobileHidden(open.html);
    contains(open.html, 'Proceder al Checkout');
    assert.match(open.html, /href="\/checkout"/);
    const closed = renderPage(CART, { url, cartOpen: false, withWhatsapp: true });
    if (url === '/terminos') assert.ok(!floatingWhatsappClasses(closed.html).has('hidden'), 'Closing the drawer restores normal visibility');
    else assertMobileHidden(closed.html);
    assert.ok(!text(closed.html).includes('Mi Carrito'));
  }
});

test('la ficha conserva Agregar al Carrito y espacio inferior seguro sin WhatsApp móvil encima', () => {
  for (const supplyType of ['stock_propio', 'bajo_pedido']) {
    const { html } = renderPage(PRODUCT, { withWhatsapp: true,
      variant: { supplyType, commercialStatus: supplyType === 'bajo_pedido' ? 'bajo_pedido' : 'disponible' } });
    assertMobileHidden(html);
    contains(html, 'Versace Eros EDT 100 ml');
    const addButton = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
      .map(([button]) => button).find((button) => text(button).includes('Agregar al Carrito'));
    assert.ok(addButton, 'The purchase button must still render');
    assert.doesNotMatch(addButton.split('>')[0], /\sdisabled(?:=|\s|$)/);
    const page = classesIn(html.match(/<div\b[^>]*class="[^"]*max-w-7xl[^"\n]*"[^>]*>/)?.[0]);
    assert.ok(page.has('pb-[calc(10rem+env(safe-area-inset-bottom,0px))]'));
    assert.ok(page.has('lg:pb-8'), 'Desktop keeps the existing bottom spacing');
    if (supplyType === 'bajo_pedido') contains(html, 'Se aparta con el 50% de este producto');
  }
});

test('checkout deja espacio inferior y conserva código postal, SINPE y panel PayPal sin el flotante móvil', () => {
  for (const paymentMethod of ['sinpe', 'paypal']) {
    const { html } = renderPage(CHECKOUT, { items: [line('bajo_pedido', 32000)], paymentMethod,
      paypalAvailable: true, paypalQuote: serverQuote({ total: 32000, balance: 16000, deposit: 16000, backorder: 32000 }),
      withWhatsapp: true });
    assertMobileHidden(html);
    contains(html, 'Código Postal (auto-llena dirección)');
    assert.match(html, /<input\b[^>]*placeholder="Ej: 10301"[^>]*>/);
    const page = classesIn(html.match(/<div\b[^>]*class="[^"]*max-w-4xl[^"\n]*"[^>]*>/)?.[0]);
    assert.ok(page.has('pb-[calc(6rem+env(safe-area-inset-bottom,0px))]'));
    assert.ok(page.has('lg:pb-8'));
    if (paymentMethod === 'paypal') {
      assert.match(html, /data-testid="paypal-panel"/);
      assert.match(html, /data-testid="paypal-quote"/);
      assert.ok(html.includes('min-h-[50px]'), 'The PayPal SDK button container still renders');
      contains(html, `Pagás ahora ${formatCRC(16000)} (apartado 50%)`);
    } else {
      contains(html, `Apartá con ${formatCRC(16000)} (50%)`);
      contains(html, '8310-0015');
      contains(html, 'Carlos Jiménez Arias');
    }
  }
});

test('carrito conserva lista desplazable y pie de compra con espacio para el área segura', () => {
  const { html } = renderPage(CART, { url: '/', cartOpen: true,
    items: Array.from({ length: 8 }, (_, index) => line('stock_propio', 47000, `stock-${index}`)), withWhatsapp: true });
  assertMobileHidden(html);
  const divs = [...html.matchAll(/<div\b[^>]*>/g)].map(([tag]) => classesIn(tag));
  assert.ok(divs.some((classes) => classes.has('h-dvh') && classes.has('max-h-full')),
    'The drawer follows the dynamic viewport and stays within its overlay');
  assert.ok(divs.some((classes) => classes.has('flex-1') && classes.has('min-h-0') && classes.has('overflow-y-auto')),
    'The item list can shrink and scroll instead of pushing checkout below the viewport');
  assert.ok(divs.some((classes) => classes.has('shrink-0')
    && classes.has('pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))]') && classes.has('lg:pb-5')),
  'The checkout footer retains its height and safe-area bottom padding');
  contains(html, 'Proceder al Checkout');
});

test('resumen distingue tres unidades de una sola variante y permite editar cantidades', () => {
  const page = renderPage(CHECKOUT, { items: [{ ...line('stock_propio', 1000), quantity: 3 }] });
  contains(page.html, '3 unidades · 1 variante');
  assert.match(page.html, /href="\/carrito"[^>]*>Editar cantidades/);
});
