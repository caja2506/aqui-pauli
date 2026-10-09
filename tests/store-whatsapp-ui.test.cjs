const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const Router = require('react-router-dom');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const pendingOrder = {
  id: 'order-test', orderNumber: 'AP-TEST', paymentStatus: 'pendiente',
  status: 'creado', total: 2000, createdAt: '2026-01-01T00:00:00Z',
  itemsSummary: [],
};
const contact = {
  id: 'contact-test', phone: '50680000000', lastChannel: 'whatsapp',
  displayName: 'Contacto de prueba', unresolvedAttentionRequired: true,
  totalMessages: 1,
};

function loadComponent(relativePath, enabled, harness = {}) {
  const setters = [];
  const calls = { send: [], update: [], alerts: [], console: [] };
  let stateIndex = 0;
  const states = harness.states;
  const reactForComponent = {
    ...React,
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: (initial) => {
      const index = stateIndex++;
      const value = states ? states[index] : typeof initial === 'function' ? initial() : initial;
      return [value, (next) => setters.push({ index, next })];
    },
  };
  const noSideEffect = () => { throw new Error('Unexpected Firestore effect while rendering'); };
  const mocks = {
    react: reactForComponent,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-router-dom': Router,
    '../../contexts/AuthContext': { useAuth: () => ({ user: { uid: 'user-test' }, loading: false }) },
    '../../hooks/useCollection': { useCollection: () => ({ data: [contact], loading: false }) },
    '../../firebase': { db: {}, functions: {} },
    'firebase/firestore': {
      collection: noSideEffect, query: noSideEffect, where: noSideEffect,
      orderBy: noSideEffect, getDocs: noSideEffect, onSnapshot: noSideEffect,
      deleteDoc: noSideEffect, writeBatch: noSideEffect,
      doc: (...args) => args,
      updateDoc: async (...args) => calls.update.push(args),
    },
    'firebase/functions': {
      httpsCallable: (_functions, name) => async (payload) => {
        calls.send.push({ name, payload });
        return { data: { status: harness.backendStatus || 'sent', messageId: 'message-test' } };
      },
    },
    '../../utils/formatters': { formatCRC: (n) => '₡' + n, formatDateTime: () => '01/01/2026' },
    '../../utils/constants': { ORDER_STATUS_LABELS: { creado: 'Creado' } },
    '../../components/ui/ConfirmDialog': () => null,
  };

  function evaluate(filename) {
    const module = { exports: {} };
    const source = fs.readFileSync(filename, 'utf8');
    const code = transformSync(source, {
      loader: filename.endsWith('.jsx') ? 'jsx' : 'js',
      format: 'cjs', jsx: 'automatic',
      define: { 'import.meta.env.VITE_STORE_WHATSAPP_ENABLED': enabled === undefined ? 'undefined' : JSON.stringify(enabled) },
    }).code;
    vm.runInNewContext(code, {
      module, exports: module.exports,
      require: (id) => id.endsWith('/storeWhatsApp')
        ? evaluate(path.resolve(path.dirname(filename), id + '.js'))
        : Object.hasOwn(mocks, id) ? mocks[id] : require(id),
      console: { error: (...args) => calls.console.push(args), log: () => {}, warn: () => {} },
      alert: (message) => calls.alerts.push(message),
      setTimeout, clearTimeout,
    }, { filename });
    return module.exports;
  }
  return { Component: evaluate(path.resolve(root, relativePath)).default, setters, calls };
}

function renderComponent(relativePath, enabled, options = {}) {
  const { Component } = loadComponent(relativePath, enabled, options);
  const entry = {
    pathname: '/orden-confirmada/order-test',
    state: { orderNumber: 'AP-TEST', total: 2000, paymentMethod: options.paymentMethod || 'sinpe' },
  };
  return renderToStaticMarkup(React.createElement(Router.MemoryRouter, { initialEntries: [entry] },
    React.createElement(Router.Routes, null,
      React.createElement(Router.Route, {
        path: '/orden-confirmada/:orderId', element: React.createElement(Component),
      }))));
}

const publicPaths = [
  'src/components/storefront/WhatsAppButton.jsx',
  'src/components/storefront/Footer.jsx',
  'src/pages/store/OrderConfirmation.jsx',
  'src/pages/store/MyOrdersPage.jsx',
];

for (const enabled of [undefined, '', 'false', 'TRUE', true]) {
  test('WhatsApp public controls stay off for ' + String(enabled), () => {
    for (const relativePath of publicPaths) {
      const html = renderComponent(relativePath, enabled, relativePath.endsWith('MyOrdersPage.jsx')
        ? { states: [[pendingOrder], false] } : {});
      assert.doesNotMatch(html, /wa\.me|WhatsApp|7095.?6070/i, relativePath);
    }
  });
}

test('Explicit opt-in restores the public WhatsApp links and contact', () => {
  const button = renderComponent(publicPaths[0], 'true');
  const footer = renderComponent(publicPaths[1], 'true');
  const confirmation = renderComponent(publicPaths[2], 'true');
  const orders = renderComponent(publicPaths[3], 'true', { states: [[pendingOrder], false] });
  assert.match(button, /https:\/\/wa\.me\/50670956070\?text=/);
  assert.match(footer, /WhatsApp: \+506 7095-6070/);
  assert.match(confirmation, /https:\/\/wa\.me\/50670956070\?text=/);
  assert.match(orders, /https:\/\/wa\.me\/50670956070\?text=/);
  assert.match(confirmation, /Enviar Comprobante por WhatsApp/);
});

for (const paymentMethod of ['sinpe', 'transferencia']) {
  test('Offline confirmation keeps payment and order instructions for ' + paymentMethod, () => {
    const html = renderComponent(publicPaths[2], undefined, { paymentMethod });
    assert.match(html, /Realiza el pago con el método seleccionado/);
    assert.match(html, /Conservá tu comprobante de pago/);
    assert.match(html, /href="\/mi-cuenta"/);
    assert.doesNotMatch(html, /Recibirás actualizaciones por WhatsApp|Enviar Comprobante por WhatsApp/);
  });
}

test('Existing non-WhatsApp contacts remain visible in the footer', () => {
  const html = renderComponent(publicPaths[1], undefined);
  assert.match(html, /info@aquipauli\.com/);
  assert.match(html, /https:\/\/www\.instagram\.com\/aqui\.paulina/);
});

test('Paid orders do not show a proof request with WhatsApp enabled', () => {
  const html = renderComponent(publicPaths[3], 'true', {
    states: [[{ ...pendingOrder, paymentStatus: 'verificado' }], false],
  });
  assert.doesNotMatch(html, /wa\.me|Enviar Comprobante/);
  assert.match(html, /AP-TEST/);
});

function supportHarness(enabled, backendStatus) {
  const loaded = loadComponent('src/pages/admin/SoportePage.jsx', enabled, {
    states: [contact, [], false, 'Respuesta de prueba', false, '', 'all', true, { isOpen: false }],
    backendStatus,
  });
  const tree = loaded.Component();
  function findSendButton(element) {
    if (!element || typeof element !== 'object') return null;
    if (element.type === 'button' && element.props.onClick?.constructor?.name === 'AsyncFunction') return element;
    for (const child of React.Children.toArray(element.props?.children)) {
      const result = findSendButton(child);
      if (result) return result;
    }
    return null;
  }
  const button = findSendButton(tree);
  assert.ok(button, 'The actual support send callback is reachable in the fixture');
  return { ...loaded, button };
}

test('Offline support keeps history and blocks even an invoked retained callback', async () => {
  const h = supportHarness(undefined, 'sent');
  assert.equal(h.button.props.disabled, true);
  await h.button.props.onClick();
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.calls.update.length, 0);
  assert.equal(h.setters.length, 0);
  const html = renderComponent('src/pages/admin/SoportePage.jsx', undefined, {
    states: [contact, [], false, 'Respuesta de prueba', false, '', 'all', true, { isOpen: false }],
  });
  assert.match(html, /WhatsApp está desactivado en esta tienda/);
  assert.match(html, /Podés consultar el historial/);
});

for (const backendStatus of ['disabled', 'retired', 'stub_logged', 'unknown']) {
  test('Support does not resolve a contact for backend result ' + backendStatus, async () => {
    const h = supportHarness('true', backendStatus);
    await h.button.props.onClick();
    assert.equal(h.calls.send.length, 1);
    assert.equal(h.calls.update.length, 0);
    assert.equal(h.calls.alerts.length, 1);
    assert.ok(h.setters.some(({ index, next }) => index === 3 && next === 'Respuesta de prueba'));
  });
}

test('Support only resolves the contact after the existing backend sent result', async () => {
  const h = supportHarness('true', 'sent');
  await h.button.props.onClick();
  assert.equal(h.calls.send.length, 1);
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.calls.update[0][1].unresolvedAttentionRequired, false);
  assert.equal(h.calls.alerts.length, 0);
});
