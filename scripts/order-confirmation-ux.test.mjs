// Actual confirmation, optional account prompt and title hook. External auth,
// Firestore, clipboard and payment operations are never executed.
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

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const abs = relative => path.join(root, relative);
const CONFIRMATION = 'src/pages/store/OrderConfirmation.jsx';
const PROMPT = 'src/components/auth/SaveAccountPrompt.jsx';
const TITLE = 'src/hooks/usePageTitle.js';
const compiled = new Map(await Promise.all([
  CONFIRMATION, PROMPT, TITLE, 'src/components/auth/FacebookIcon.jsx',
  'src/components/ui/CopyButton.jsx', 'src/utils/formatters.js',
  'src/utils/constants.js', 'src/utils/backorder.js', 'src/services/payments/paypalQuote.js', 'src/services/payments/tilopayQuote.js',
].map(async relative => {
  const filename = abs(relative);
  const { code } = await transformWithEsbuild(await readFile(filename, 'utf8'), filename,
    { loader: filename.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic', format: 'cjs', target: 'es2022' });
  return [filename, code];
})));
const forbidden = name => () => { throw new Error(`External operation forbidden: ${name}`); };

function render({ savedOrder = null, state = {}, guest = true, facebook = true, compact = false, relative = CONFIRMATION } = {}) {
  const effects = [];
  const cleanups = [];
  const buttons = [];
  const elements = [];
  const user = { uid: 'fixture-user', isAnonymous: guest };
  const jsx = require('react/jsx-runtime');
  const jsxSpies = { ...jsx, ...Object.fromEntries(['jsx', 'jsxs'].map(key => [key, (type, props, ...rest) => {
    if (typeof type === 'string') elements.push({ type, props });
    if (type === 'button') buttons.push(props);
    return jsx[key](type, props, ...rest);
  }])) };
  const mocks = new Map([
    [abs('src/firebase.js'), { db: {} }],
    [abs('src/contexts/AuthContext.js'), {
      useAuth: () => ({ user, loading: false, signInWithGoogle: forbidden('Google login'), signInWithFacebook: forbidden('Facebook login') }),
      socialAuthErrorMessage: forbidden('auth error mapping'),
    }],
    [abs('src/hooks/useAuthFlags.js'), { useAuthFlags: () => ({ facebookEnabled: facebook }) }],
  ]);
  const cache = new Map();
  function load(filename) {
    if (mocks.has(filename)) return mocks.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    assert.ok(compiled.has(filename), `Unexpected import: ${path.relative(root, filename)}`);
    const module = { exports: {} }; cache.set(filename, module);
    const localRequire = name => {
      if (name === 'react' && filename === abs(CONFIRMATION)) return {
        ...React, useState: initial => React.useState(initial === null ? savedOrder : initial),
      };
      if (name === 'react' && filename === abs(TITLE)) return {
        ...React, useEffect(effect, dependencies) { effects.push(effect); React.useEffect(effect, dependencies); },
      };
      if (name === 'react/jsx-runtime') return jsxSpies;
      if (['react', 'react-router-dom', 'lucide-react'].includes(name)) return require(name);
      if (name === 'firebase/firestore') return { doc: forbidden('Firestore doc'), getDoc: forbidden('Firestore read') };
      assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`);
      const target = path.resolve(path.dirname(filename), name);
      const resolved = (path.extname(target) ? [target] : [`${target}.js`, `${target}.jsx`])
        .find(candidate => mocks.has(candidate) || compiled.has(candidate));
      assert.ok(resolved, `Unresolved dependency: ${name}`);
      return load(resolved);
    };
    new Function('require', 'module', 'exports', compiled.get(filename))(localRequire, module, module.exports);
    return module.exports;
  }
  const Component = load(abs(relative)).default;
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, {
    initialEntries: [{ pathname: '/pedido-confirmado/order-id', state }],
  }, React.createElement(Routes, null, React.createElement(Route, { path: '/pedido-confirmado/:orderId',
    element: React.createElement(Component, { compact }),
  }))));
  return {
    html, buttons, elements,
    mountTitle() { effects.forEach(effect => cleanups.push(effect())); },
    unmountTitle() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}

test('confirmación pone el número canónico en el título y restaura la pestaña al salir', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { title: 'Aquí Pauli' };
  try {
    const page = render({ savedOrder: { orderNumber: 'AP-REAL', total: 52000 }, state: { orderNumber: 'AP-ANTERIOR' } });
    page.mountTitle();
    assert.equal(document.title, 'Pedido AP-REAL | Aquí Pauli');
    page.unmountTitle();
    assert.equal(document.title, 'Aquí Pauli');
    const loading = render({ state: { orderNumber: 'AP-DESDE-CHECKOUT' } });
    loading.mountTitle();
    assert.equal(document.title, 'Pedido AP-DESDE-CHECKOUT | Aquí Pauli');
    loading.unmountTitle();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else delete globalThis.document;
  }
});

test('el aviso Opcional ocupa su propia fila y los botones quedan debajo sin comprimir el texto', () => {
  const page = render();
  assert.match(page.html, />Opcional<\/p>/);
  assert.match(page.html, /Los pedidos de invitado no se transfieren automáticamente/);
  const prompt = page.elements.find(el => el.props['data-testid'] === 'save-account');
  const description = page.elements.find(el => el.props['data-testid'] === 'save-account-description');
  const actions = page.elements.find(el => el.props['data-testid'] === 'save-account-actions');
  assert.ok(prompt && description && actions);
  assert.ok(!prompt.props.className.includes('sm:flex-row'));
  const directChildren = React.Children.toArray(prompt.props.children);
  assert.equal(directChildren.length, 2);
  assert.equal(directChildren[0].props['data-testid'], 'save-account-description');
  assert.equal(directChildren[1].props['data-testid'], 'save-account-actions');
  assert.match(actions.props.className, /grid-cols-1 sm:grid-cols-2/);
  assert.equal(page.buttons.filter(button => button.type === 'button').length, 2);
  assert.ok(page.buttons.every(button => button.className.includes('min-w-0') && button.className.includes('w-full')));
});

test('la cuenta guardada oculta Opcional, y Facebook deshabilitado conserva solo Google', () => {
  assert.ok(!render({ guest: false }).html.includes('data-testid="save-account"'));
  const googleOnly = render({ facebook: false });
  assert.match(googleOnly.html, /Guardar mi cuenta con Google/);
  assert.ok(!googleOnly.html.includes('Guardar mi cuenta con Facebook'));
  assert.match(render({ relative: PROMPT, compact: true }).html, /Estás comprando como invitado/);
});

test('las notas canónicas se muestran con saltos de línea y caracteres escapados', () => {
  const notes = 'Entregar después de las 4 p. m.\n<script>alert("x")</script> & regalo';
  const page = render({ savedOrder: { orderNumber: 'AP-NOTAS', customerNotes: notes }, state: { customerNotes: 'No mostrar' } });
  assert.match(page.html, /data-testid="order-customer-notes"/);
  assert.match(page.html, /whitespace-pre-wrap break-words/);
  assert.ok(page.html.includes('4 p. m.\n&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; regalo'));
  assert.ok(!page.html.includes('<script>'));
  assert.ok(!page.html.includes('No mostrar'));
});

test('las notas del checkout aparecen durante la carga; vacío o valor inválido no añade un panel', () => {
  assert.match(render({ state: { customerNotes: 'Portón azul' } }).html, /Portón azul/);
  for (const customerNotes of [undefined, null, '', '   ', {}, 4]) {
    assert.ok(!render({ savedOrder: { customerNotes } }).html.includes('data-testid="order-customer-notes"'));
  }
  assert.ok(!render({ savedOrder: { orderNumber: 'AP-SIN-NOTAS' }, state: { customerNotes: 'Estado viejo' } }).html.includes('Estado viejo'));
});

test('contra entrega indica cero adelanto y total en efectivo, sin comprobante ni falso pago online', () => {
  const page = render({ state: {
    orderNumber: 'AP-CONTRA-ENTREGA', total: 52000, paymentMethod: 'contra_entrega',
    // Un estado de navegación viejo no acredita un pago ni cambia el método.
    paid: true, online: true,
  } });
  assert.match(page.html, /data-testid="cash-on-delivery-confirmation"/);
  assert.match(page.html, /Pago contra entrega \(efectivo\)/);
  assert.match(page.html, /Pagás ahora: <strong>₡0<\/strong>/);
  assert.match(page.html, /Total a pagar al recibir: <strong>₡52\s000<\/strong>/);
  assert.match(page.html, /pendiente de cobro contra entrega/);
  assert.match(page.html, /No necesitás un adelanto/);
  assert.doesNotMatch(page.html, /Enviar Comprobante|Adjunto mi comprobante|Pagué|Pago recibido|Pago en efectivo registrado|Realiza el pago/);
  assert.ok(!page.elements.some(element => element.type === 'a' && element.props.href?.startsWith('https://wa.me/')));
});

test('al recargar contra entrega usa total, método y notas guardados, aunque el estado de navegación difiera', () => {
  const savedOrder = { orderNumber: 'AP-COD-GUARDADO', total: 32000, paymentMethod: 'contra_entrega',
    paymentStatus: 'pendiente', status: 'pendiente_pago', customerNotes: 'Llamar al llegar',
    itemsSummary: [{ supplyType: 'stock_propio', price: 32000, quantity: 1 }], shippingCost: 0 };
  for (const state of [{}, { orderNumber: 'AP-VIEJO', total: 1, paymentMethod: 'sinpe', paid: true, online: true }]) {
    const page = render({ savedOrder, state });
    assert.match(page.html, /AP-COD-GUARDADO/);
    assert.match(page.html, /Total a pagar al recibir: <strong>₡32\s000<\/strong>/);
    assert.match(page.html, /Llamar al llegar/);
    assert.match(page.html, /pendiente de cobro contra entrega/);
    assert.doesNotMatch(page.html, /data-testid="sinpe-instructions"|Enviar Comprobante|Pago recibido|AP-VIEJO/);
  }
});

test('contra entrega ya cobrado no vuelve a pedir efectivo al recargar', () => {
  for (const paymentStatus of ['pagado', 'verificado']) {
    const page = render({ savedOrder: { orderNumber: 'AP-COD-COBRADO', total: 52000,
      paymentMethod: 'contra_entrega', paymentStatus, status: 'entregado' },
      state: { paid: false, online: true } });
    assert.match(page.html, /Pago en efectivo registrado/);
    assert.doesNotMatch(page.html, /Total a pagar al recibir|Prepará el monto|pendiente de cobro|Enviar Comprobante|Pago recibido con PayPal/);
  }
});

test('contra entrega cancelado no deja instrucciones de cobro pendientes', () => {
  const page = render({ savedOrder: { orderNumber: 'AP-COD-CANCELADO', total: 52000,
    paymentMethod: 'contra_entrega', paymentStatus: 'pendiente', status: 'cancelado' } });
  assert.match(page.html, /Este pedido fue cancelado/);
  assert.doesNotMatch(page.html, /Total a pagar al recibir|Prepará el monto|Estado del pago: pendiente|Enviar Comprobante/);
});

test('el método guardado de una orden PayPal prevalece sobre un estado anterior de contra entrega', () => {
  const page = render({ savedOrder: { orderNumber: 'AP-PAYPAL', total: 52000,
    paymentMethod: 'paypal', paymentStatus: 'pagado', paymentAmount: 52000 },
    state: { paymentMethod: 'contra_entrega', total: 1 } });
  assert.match(page.html, /Pago recibido con PayPal/);
  assert.ok(!page.html.includes('data-testid="cash-on-delivery-confirmation"'));
});

const cardQuote = { currency: 'CRC', crcSubtotal: 62000, crcShipping: 3000, crcTotal: 65000,
  crcPayNow: 49000, crcBalanceDue: 16000, crcBackorderSubtotal: 32000, crcDepositTotal: 16000, hasBackorder: true };

test('retorno Tilopay parcial muestra apartado, total completo y saldo antes de cargar el pedido', () => {
  const page = render({ state: { orderNumber: 'AP-TARJETA', total: 65000, paymentMethod: 'tilopay',
    online: true, paid: true, partial: true, tilopayQuote: cardQuote } });
  assert.match(page.html, /Apartado recibido con tarjeta/);
  assert.match(page.html, /Monto recibido: <strong>₡49\s000<\/strong>/);
  assert.match(page.html, /Total del pedido: <strong>₡65\s000<\/strong>/);
  assert.match(page.html, /Saldo pendiente: <strong>₡16\s000<\/strong>/);
  assert.match(page.html, /50% de los productos Bajo pedido/);
  assert.doesNotMatch(page.html, /Pago recibido con tarjeta|está en revisión|Enviar Comprobante/);
});

test('Tilopay recargado usa pago parcial, importes y método guardados por el servidor', () => {
  const page = render({ savedOrder: { orderNumber: 'AP-TARJETA-GUARDADO', total: 65000,
    paymentMethod: 'tilopay', paymentStatus: 'parcial', paymentAmount: 49000, remainingTotal: 16000,
    tilopay: cardQuote }, state: { paymentMethod: 'paypal', total: 1, paid: false, partial: false } });
  assert.match(page.html, /Apartado recibido con tarjeta/);
  assert.match(page.html, /Monto recibido: <strong>₡49\s000<\/strong>/);
  assert.match(page.html, /Saldo pendiente: <strong>₡16\s000<\/strong>/);
  assert.doesNotMatch(page.html, /Pago recibido con tarjeta|está en revisión|Tu pago con PayPal/);
});

test('Tilopay pendiente no confirma un apartado por datos viejos de navegación', () => {
  const page = render({ savedOrder: { orderNumber: 'AP-TARJETA-PENDIENTE', total: 65000,
    paymentMethod: 'tilopay', paymentStatus: 'pendiente', tilopay: cardQuote },
  state: { paid: true, partial: true } });
  assert.match(page.html, /Tu pago con tarjeta está en revisión/);
  assert.match(page.html, /Monto del pago en revisión: <strong>₡49\s000<\/strong>/);
  assert.doesNotMatch(page.html, /Apartado recibido|Pago recibido|Monto recibido/);
});

test('Tilopay histórico o ya cancelado completo conserva pago total y saldo cero', () => {
  for (const options of [
    { state: { orderNumber: 'AP-LEGACY', total: 65000, paymentMethod: 'tilopay', online: true, paid: true } },
    { savedOrder: { orderNumber: 'AP-LEGACY', total: 65000, paymentMethod: 'tilopay', paymentStatus: 'pagado',
      paymentAmount: 65000, remainingTotal: 0, tilopay: { crcTotal: 65000, currency: 'CRC' },
      itemsSummary: [{ supplyType: 'bajo_pedido', price: 62000, quantity: 1 }], shippingCost: 3000, depositTotal: 31000 } },
    { savedOrder: { orderNumber: 'AP-SALDADO', total: 65000, paymentMethod: 'tilopay', paymentStatus: 'verificado',
      paymentAmount: 65000, remainingTotal: 0, tilopay: cardQuote } },
  ]) {
    const page = render(options);
    assert.match(page.html, /Pago recibido con tarjeta/);
    assert.match(page.html, /Monto recibido: <strong>₡65\s000<\/strong>/);
    assert.match(page.html, /Saldo pendiente: <strong>₡0<\/strong>/);
    assert.doesNotMatch(page.html, /Apartado recibido|apartado 50%|Tu apartado/);
  }
});
