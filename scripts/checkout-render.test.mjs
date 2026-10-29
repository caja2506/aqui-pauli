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

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const CHECKOUT = 'src/pages/store/CheckoutPage.jsx';
const CART = 'src/components/storefront/CartDrawer.jsx';
const CONFIRMATION = 'src/pages/store/OrderConfirmation.jsx';
const realFiles = [
  CHECKOUT, CART, CONFIRMATION,
  'src/utils/backorder.js', 'src/utils/constants.js', 'src/utils/formatters.js',
  'src/services/payments/registry.js', 'src/data/costaRicaTerritorial.js',
  'src/components/ui/CopyButton.jsx', 'src/components/ui/LoadingSpinner.jsx',
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

function renderPage(relative, options = {}) {
  const items = options.items || [];
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const shippingCost = options.shippingCost || 0;
  const availability = options.paypalAvailable ? { paypal: { available: true } } : {};
  const paypalTotals = [];
  const cache = new Map();
  const abs = (name) => path.join(root, name);
  const user = { uid: 'render-test-user', displayName: 'Ana Prueba', email: 'ana@example.invalid', isAnonymous: false };
  const paypalProvider = {
    id: 'paypal', kind: 'online', label: 'PayPal / Tarjeta',
    getAvailability: forbidden('PayPal availability'),
    Panel: ({ totalCRC }) => {
      paypalTotals.push(totalCRC);
      return React.createElement('div', { 'data-testid': 'paypal-panel', 'data-total-crc': totalCRC }, 'Panel PayPal simulado');
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
      return React.useState(value);
    },
  };
  const confirmationReact = {
    ...React,
    useState(initial) {
      return React.useState(initial === null && options.savedOrder ? options.savedOrder : initial);
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
        : filename === abs(CONFIRMATION) ? confirmationReact : React;
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
    path: routePath, element: React.createElement(Component),
  }))));
  return { html, paypalTotals };
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

test('PayPal conserva recomendado, primera opción y total completo del pedido mixto', () => {
  const { html, paypalTotals } = renderPage(CHECKOUT, {
    items: [line('stock_propio', 30000), line('bajo_pedido', 10000)], shippingCost: 5000,
    paypalAvailable: true, paymentMethod: 'paypal',
  });
  contains(html, 'Recomendado');
  contains(html, 'Pagá con PayPal y comprás protegido');
  assert.ok(html.indexOf('value="paypal"') < html.indexOf('value="sinpe"'));
  assert.deepEqual(paypalTotals, [45000]);
  assert.match(html, /data-testid="paypal-panel"/);
  assert.doesNotMatch(html, /data-testid="deposit-summary"/);
  assert.doesNotMatch(html, /type="submit"/);
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
