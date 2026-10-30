// Render actual routes and cart JSX. DOM boundaries are local fixtures; no auth,
// Firestore writes, payment calls or browser navigation leave this process.
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
const APP = 'src/App.jsx';
const CART = 'src/pages/store/CartPage.jsx';
const DRAWER = 'src/components/storefront/CartDrawer.jsx';
const TITLE = 'src/hooks/usePageTitle.js';
const abs = relative => path.join(root, relative);
const realFiles = [APP, CART, DRAWER, TITLE, 'src/utils/backorder.js', 'src/utils/formatters.js'];
const compiled = new Map(await Promise.all(realFiles.map(async relative => {
  const filename = abs(relative);
  const { code } = await transformWithEsbuild(await readFile(filename, 'utf8'), filename, {
    loader: filename.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic', format: 'cjs', target: 'es2022', sourcemap: false,
  });
  return [filename, code];
})));

const stockLine = { productId: 'perfume', variantId: '100ml', productName: 'Perfume disponible', variantName: '100 ml', price: 40000, quantity: 1, supplyType: 'stock_propio', imageUrl: '' };
const backorderLine = { productId: 'tenis', variantId: 'rojo34', productName: 'Tenis de prueba', variantName: 'Rojo 34', price: 32000, quantity: 2, supplyType: 'bajo_pedido', imageUrl: '' };
const plainText = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function renderSource(relative, options = {}) {
  const items = options.items || [];
  const effects = [];
  const cleanups = [];
  const refs = [];
  const elements = [];
  const calls = { open: [], remove: [], quantity: [] };
  const cart = {
    items, subtotal: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    isCartOpen: Boolean(options.open), setIsCartOpen: value => calls.open.push(value),
    removeItem: (...args) => calls.remove.push(args), updateQuantity: (...args) => calls.quantity.push(args),
  };
  const emptyComponent = name => ({ __esModule: true, default: () => React.createElement('div', { 'data-stub': name }) });
  const modules = new Map([
    [abs('src/contexts/CartContext.js'), { useCart: () => cart }],
    [abs('src/contexts/AuthContext.js'), { useAuth: () => ({ user: null, loading: false }) }],
    [abs('src/contexts/RoleContext.js'), { useRole: () => ({ isAdmin: false, roleLoading: false }) }],
    [abs('src/pages/store/LegalPages.js'), Object.fromEntries(['TerminosPage', 'DevolucionesPage', 'EnviosPage', 'PrivacidadPage'].map(name => [name, () => null]))],
  ]);
  for (const relative of [
    'components/storefront/Navbar', 'components/storefront/Footer', 'components/storefront/WhatsAppButton',
    'components/admin/AdminSidebar', 'components/auth/LoginPage',
    ...['HomePage', 'CatalogPage', 'ProductPage', 'CheckoutPage', 'OrderConfirmation', 'TilopayReturnPage', 'MyOrdersPage', 'NotFoundPage', 'GiveawayPage', 'GiveawayRulesPage'].map(name => `pages/store/${name}`),
    ...['DashboardPage', 'BrandsPage', 'CategoriesPage', 'ProductsPage', 'OrdersPage', 'CrmPage', 'ShippingPage', 'GiveawayAdminPage'].map(name => `pages/admin/${name}`),
  ]) modules.set(abs(`src/${relative}.js`), emptyComponent(relative));

  const cache = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    assert.ok(compiled.has(filename), `Unexpected source import: ${path.relative(root, filename)}`);
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = name => {
      if (name === 'react/jsx-runtime') {
        const runtime = require(name);
        return { ...runtime, ...Object.fromEntries(['jsx', 'jsxs'].map(factory => [factory, (type, props, key) => {
          if (typeof type === 'string') elements.push({ type, props });
          return runtime[factory](type, props, key);
        }])) };
      }
      if (name === 'react' && [abs(DRAWER), abs(TITLE)].includes(filename)) return {
        ...React,
        useEffect(effect, deps) { effects.push(effect); React.useEffect(effect, deps); },
        useRef(initial) { const ref = React.useRef(initial); refs.push(ref); return ref; },
      };
      if (name === 'react-router-dom' && filename === abs(APP)) return {
        ...require(name), BrowserRouter: ({ children }) => React.createElement(MemoryRouter, { initialEntries: [options.pathname || '/carrito'] }, children),
      };
      if (['react', 'react-router-dom', 'lucide-react'].includes(name)) return require(name);
      assert.ok(name.startsWith('.'), `Unexpected external import: ${name}`);
      const target = path.resolve(path.dirname(filename), name);
      const choices = path.extname(target) ? [target] : [`${target}.js`, `${target}.jsx`];
      const resolved = choices.find(choice => modules.has(choice) || compiled.has(choice));
      assert.ok(resolved, `Unresolved source import: ${name}`);
      return load(resolved);
    };
    new Function('require', 'module', 'exports', compiled.get(filename))(localRequire, module, module.exports);
    return module.exports;
  }

  const Component = load(abs(relative)).default;
  const element = React.createElement(Component);
  const html = renderToStaticMarkup(relative === APP ? element : React.createElement(MemoryRouter, null, element));
  return { html, elements, refs, calls,
    mountEffects() { for (const effect of effects) cleanups.push(effect()); },
    unmount() { for (const cleanup of cleanups.reverse()) cleanup?.(); },
  };
}

test('/carrito renderiza su página propia, incluso sin sesión, y no redirige a checkout', () => {
  const page = renderSource(APP, { pathname: '/carrito', items: [stockLine] });
  assert.match(page.html, /<h1[^>]*>Mi carrito<\/h1>/);
  assert.match(page.html, /Perfume disponible/);
  assert.match(page.html, /href="\/checkout"/);
  assert.doesNotMatch(page.html, /data-stub="pages\/store\/CheckoutPage"/);
  const checkout = renderSource(APP, { pathname: '/checkout' });
  assert.match(checkout.html, /data-stub="pages\/store\/CheckoutPage"/);
});

test('carrito vacío conserva su ruta y ofrece volver al catálogo sin botón de compra', () => {
  const page = renderSource(APP, { pathname: '/carrito' });
  assert.match(page.html, /Tu carrito está vacío/);
  assert.match(page.html, /href="\/catalogo"/);
  assert.doesNotMatch(page.html, /href="\/checkout"/);
});

test('carrito con stock y Bajo pedido conserva pago completo de stock y apartado solo de las líneas Bajo pedido', () => {
  const page = renderSource(CART, { items: [stockLine, backorderLine] });
  const text = plainText(page.html);
  assert.match(text, /3 productos en tu carrito/);
  assert.match(text, /Total del pedido ₡104 000/);
  assert.match(text, /Pagás ahora ₡72 000/);
  assert.match(text, /Saldo pendiente ₡32 000/);
  assert.match(text, /50% de las líneas Bajo pedido y el importe completo de los productos en stock/);
  assert.match(page.html, /href="\/producto\/tenis"/);
  const stockOnly = renderSource(CART, { items: [stockLine] });
  assert.match(plainText(stockOnly.html), /Total del pedido ₡40 000/);
  assert.doesNotMatch(stockOnly.html, /Saldo pendiente|Pagás ahora/);
});

test('los controles del carrito actualizan la variante correcta y permiten quitar una línea', () => {
  const page = renderSource(CART, { items: [stockLine, backorderLine] });
  const button = label => page.elements.find(({ type, props }) => type === 'button' && props['aria-label'] === label).props;
  button('Aumentar cantidad de Tenis de prueba, Rojo 34').onClick();
  button('Reducir cantidad de Tenis de prueba, Rojo 34').onClick();
  button('Quitar Perfume disponible, 100 ml del carrito').onClick();
  assert.deepEqual(page.calls.quantity, [['tenis', 'rojo34', 3], ['tenis', 'rojo34', 1]]);
  assert.deepEqual(page.calls.remove, [['perfume', '100ml']]);
});

test('el panel expone un diálogo etiquetado, botón de cierre y enlace al carrito completo', () => {
  const page = renderSource(DRAWER, { open: true, items: [stockLine] });
  assert.match(page.html, /role="dialog"[^>]+aria-modal="true"[^>]+aria-labelledby="cart-drawer-title"/);
  assert.match(page.html, /id="cart-drawer-title"/);
  assert.match(page.html, /aria-label="Cerrar carrito"/);
  assert.match(page.html, /href="\/carrito"/);
  const close = page.elements.find(({ type, props }) => type === 'button' && props['aria-label'] === 'Cerrar carrito');
  close.props.onClick();
  assert.deepEqual(page.calls.open, [false]);
});

function withDocument(run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const listeners = new Map();
  const doc = { body: { style: { overflow: 'auto' } }, title: 'Aquí Pauli',
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); },
  };
  const node = name => ({ name, isConnected: true, getClientRects: () => [{}], focus() { doc.activeElement = this; } });
  const opener = node('opener');
  doc.activeElement = opener;
  globalThis.document = doc;
  try { run({ doc, listeners, node, opener }); } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  }
}

test('Esc cierra el panel, libera el scroll y devuelve el foco al control que lo abrió', () => {
  withDocument(({ doc, listeners, node, opener }) => {
    const page = renderSource(DRAWER, { open: true, items: [stockLine] });
    const close = node('close');
    page.refs[0].current = { querySelectorAll: () => [close], contains: element => element === close };
    page.refs[1].current = close;
    page.mountEffects();
    assert.equal(doc.activeElement, close);
    assert.equal(doc.body.style.overflow, 'hidden');
    assert.ok(listeners.has('keydown'));
    let prevented = false;
    listeners.get('keydown')({ key: 'Escape', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(page.calls.open, [false]);
    page.unmount();
    assert.equal(doc.body.style.overflow, 'auto');
    assert.equal(doc.activeElement, opener);
    assert.equal(listeners.size, 0);
  });
});

test('Tab y Shift+Tab mantienen el foco dentro del panel sin cerrar al usar otras teclas', () => {
  withDocument(({ doc, listeners, node }) => {
    const page = renderSource(DRAWER, { open: true, items: [stockLine] });
    const first = node('close');
    const last = node('checkout');
    page.refs[0].current = { querySelectorAll: () => [first, last], contains: element => [first, last].includes(element) };
    page.refs[1].current = first;
    page.mountEffects();
    let prevented = 0;
    const key = (name, shiftKey = false) => listeners.get('keydown')({ key: name, shiftKey, preventDefault() { prevented += 1; } });
    key('Tab', true);
    assert.equal(doc.activeElement, last);
    key('Tab');
    assert.equal(doc.activeElement, first);
    key('Enter');
    assert.deepEqual(page.calls.open, []);
    assert.equal(prevented, 2);
    page.unmount();
  });
});

test('el panel cerrado no intercepta teclas ni bloquea el scroll', () => {
  withDocument(({ doc, listeners, opener }) => {
    const page = renderSource(DRAWER, { open: false });
    assert.equal(page.html, '');
    page.mountEffects();
    assert.equal(listeners.size, 0);
    assert.equal(doc.body.style.overflow, 'auto');
    assert.equal(doc.activeElement, opener);
    page.unmount();
  });
});
