// Real card panel/return source and deterministic hooks. Payment, Firebase,
// browser navigation and storage boundaries are local doubles; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { transformWithEsbuild } from 'vite';
import * as quotes from '../src/services/payments/tilopayQuote.js';
import * as urls from '../src/services/payments/tilopayUrl.js';
import * as formatters from '../src/utils/formatters.js';
import * as backorder from '../src/utils/backorder.js';

const require = createRequire(import.meta.url);
const PANEL = 'src/components/payments/TilopayPanel.jsx';
const RETURN = 'src/pages/store/TilopayReturnPage.jsx';
const compiled = new Map(await Promise.all([PANEL, RETURN].map(async file => {
  const { code } = await transformWithEsbuild(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), file,
    { loader: 'jsx', jsx: 'automatic', format: 'cjs', target: 'es2022' });
  return [file, code];
})));
const STORAGE_KEY = 'aqp_tilopay_pending';
const quote = { currency: 'CRC', crcSubtotal: 62000, crcShipping: 3000, crcTotal: 65000,
  crcPayNow: 49000, crcBalanceDue: 16000, crcDepositTotal: 16000, crcBackorderSubtotal: 32000, hasBackorder: true };
const items = [{ productId: 'stock', variantId: 'unica', quantity: 1, price: 1, supplyType: 'stock_propio' },
  { productId: 'bag', variantId: 'rojo', quantity: 1, price: 1, supplyType: 'bajo_pedido' }];
const cartKey = value => JSON.stringify(value.map(item => [String(item.productId), String(item.variantId), Number(item.quantity)])
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const pending = { uid: 'buyer', orderId: 'order-one', orderNumber: 'AP-ONE', total: 65000,
  cartKey: cartKey(items), quoteKey: quotes.tilopayQuoteKey(items, 'Grecia', 'normal'), quote };
const safeUrl = 'https://app.tilopay.com/process/test-only';
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function hooks() {
  const slots = []; let cursor = 0; let effects = [];
  const slot = (kind, init) => {
    const index = cursor++;
    if (!slots[index]) slots[index] = { kind, ...init() };
    assert.equal(slots[index].kind, kind);
    return slots[index];
  };
  return {
    react: {
      ...React,
      useRef(initial) { return slot('ref', () => ({ current: initial })); },
      useState(initial) {
        const state = slot('state', () => ({ value: typeof initial === 'function' ? initial() : initial }));
        return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value; }];
      },
      useEffect(effect, deps) {
        const state = slot('effect', () => ({ deps: undefined, ready: false }));
        if (!state.ready || !deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
          state.ready = true; state.deps = deps;
          effects.push(() => { state.cleanup?.(); state.cleanup = effect(); });
        }
      },
    },
    render(fn) { cursor = 0; effects = []; const tree = fn(); effects.forEach(run => run()); return tree; },
    unmount() { slots.forEach(state => state.cleanup?.()); },
  };
}

function runtime(options = {}) {
  const hook = hooks();
  const state = { uid: 'buyer', authLoading: false, items, orderId: 'order-one', canton: 'Grecia', shippingType: 'normal', ...options.state };
  const storage = new Map(options.pending ? [[STORAGE_KEY, JSON.stringify(options.pending)]] : []);
  const calls = []; const navigations = []; const redirects = []; const quotesShown = []; const logs = [];
  let clears = 0; let tree;
  const defaults = {
    tilopayGetQuote: async () => quote,
    createPendingOrder: async () => ({ orderId: 'order-one', orderNumber: 'AP-ONE' }),
    tilopayCreatePayment: async () => ({ ...quote, orderId: 'order-one', url: safeUrl, result: 'created' }),
    tilopayConfirm: async () => ({ ...quote, orderId: 'order-one', result: 'pending' }),
  };
  const invoke = name => (...args) => { calls.push({ name, args }); return (options[name] || defaults[name])(...args); };
  const client = Object.fromEntries(['tilopayGetQuote', 'tilopayCreatePayment', 'tilopayConfirm'].map(name => [name, invoke(name)]));
  const createPendingOrder = invoke('createPendingOrder');
  const navigate = (...args) => navigations.push(args);
  const clearCart = () => { clears++; };
  const onQuote = value => quotesShown.push(value);
  const localRequire = name => {
    if (name === 'react') return hook.react;
    if (name === 'react/jsx-runtime' || name === 'lucide-react') return require(name);
    if (name === 'react-router-dom') return { ...require(name), useNavigate: () => navigate, useParams: () => ({ orderId: state.orderId }) };
    if (name.endsWith('/AuthContext')) return { useAuth: () => ({ user: state.uid ? { uid: state.uid } : null, loading: state.authLoading }) };
    if (name.endsWith('/CartContext')) return { useCart: () => ({ items: state.items, clearCart }) };
    if (name.endsWith('/tilopayClient')) return client;
    if (name.endsWith('/tilopayQuote')) return quotes;
    if (name.endsWith('/tilopayUrl')) return urls;
    if (name.endsWith('/formatters')) return formatters;
    if (name.endsWith('/backorder')) return backorder;
    throw new Error(`Unexpected source dependency: ${name}`);
  };
  const sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'sessionStorage', 'console', compiled.get(options.file || PANEL))(
    localRequire, module, module.exports, { location: { assign: value => redirects.push(value) } }, sessionStorage,
    { error: (...args) => logs.push(args) });
  const render = updates => {
    Object.assign(state, updates);
    tree = hook.render(() => module.exports.default({ canton: state.canton, shippingType: state.shippingType,
      totalCRC: 2, validateForm: options.validateForm || (() => true), createPendingOrder, onQuote }));
    return tree;
  };
  const elements = (node = tree) => {
    if (!React.isValidElement(node)) return [];
    return [node, ...React.Children.toArray(node.props.children).flatMap(child => elements(child))];
  };
  const html = () => renderToStaticMarkup(React.createElement(MemoryRouter, null, tree));
  const button = pattern => elements().find(node => node.type === 'button' && pattern.test(String(node.props.children)))?.props;
  render();
  return { render, html, button, state, calls, navigations, redirects, quotesShown, logs,
    get clears() { return clears; },
    saved: () => JSON.parse(storage.get(STORAGE_KEY) || 'null'), unmount: hook.unmount };
}

async function ready(options) { const app = runtime(options); await settle(); app.render(); return app; }
const counts = (app, name) => app.calls.filter(call => call.name === name);
const payButton = app => app.button(/^(Pagás ahora|Continuar el pedido pendiente|Calculando…|Verificando…)/);

test('cotización: clave cambia con cantidad, variante, cantón y envío; orden de líneas no la cambia', () => {
  const key = quotes.tilopayQuoteKey(items, 'Grecia', 'normal');
  assert.equal(key, quotes.tilopayQuoteKey([...items].reverse(), 'Grecia', 'normal'));
  for (const [changed, canton, shipping] of [
    [[{ ...items[0], quantity: 2 }, items[1]], 'Grecia', 'normal'],
    [[{ ...items[0], variantId: 'otra' }, items[1]], 'Grecia', 'normal'],
    [items, 'San José', 'normal'], [items, 'Grecia', 'express'],
  ]) assert.notEqual(key, quotes.tilopayQuoteKey(changed, canton, shipping));
  for (const invalid of [null, { ...quote, crcTotal: 2 }, { ...quote, crcPayNow: -1 }, { ...quote, currency: 'USD' },
    { ...quote, crcShipping: Infinity }, { ...quote, crcBalanceDue: '16000' }]) assert.equal(quotes.isPayableTilopayQuote(invalid), false);
});

test('cotización histórica BO conserva cobro completo sin inventar depósito del 50%', () => {
  const legacy = { ...quote, crcPayNow: 65000, crcBalanceDue: 0, crcDepositTotal: 0 };
  assert.equal(quotes.isPayableTilopayQuote(legacy), true);
  assert.equal(quotes.backorderFromTilopayQuote(legacy).payNowTotal, 65000);
  assert.equal(quotes.backorderFromTilopayQuote(legacy).balanceDue, 0);
  assert.deepEqual(quotes.tilopayQuoteAmounts({ ...quote, url: safeUrl, result: 'created' }), quote);
});

test('panel: Calculando… bloquea nuevos pagos sin mostrar el total local ni enviar precios del cliente', async () => {
  const request = deferred();
  const app = runtime({ tilopayGetQuote: () => request.promise });
  assert.equal(payButton(app).disabled, true);
  assert.match(app.html(), /Calculando…/);
  assert.doesNotMatch(app.html(), /Pagás ahora|₡2</);
  await payButton(app).onClick();
  assert.equal(counts(app, 'createPendingOrder').length, 0);
  assert.deepEqual(counts(app, 'tilopayGetQuote')[0].args, [{ items: items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })), canton: 'Grecia', shippingType: 'normal' }]);
  request.resolve(quote); await settle(); app.render();
  assert.equal(payButton(app).disabled, false);
  assert.match(app.html(), /Pagás ahora ₡49\s000 \(apartado 50%\)/);
  assert.match(app.html(), /Saldo pendiente: <strong>₡16\s000<\/strong>/);
});

test('panel: todo stock cobra completo y Bajo pedido cobra solo mitad más envío', async () => {
  for (const variant of [
    { ...quote, crcSubtotal: 32000, crcTotal: 35000, crcPayNow: 35000, crcBalanceDue: 0, crcBackorderSubtotal: 0, crcDepositTotal: 0, hasBackorder: false },
    { ...quote, crcSubtotal: 32000, crcTotal: 35000, crcPayNow: 19000 },
  ]) {
    const app = await ready({ tilopayGetQuote: async () => variant });
    assert.equal(payButton(app).disabled, false);
    assert.match(app.html(), new RegExp(`Pagás ahora ${formatters.formatCRC(variant.crcPayNow)}`));
    if (variant.hasBackorder) assert.match(app.html(), /apartado 50%/); else assert.doesNotMatch(app.html(), /apartado 50%/);
  }
});

test('panel: respuesta tardía de cotización no reaparece tras cambiar carrito, envío o usuario', async () => {
  for (const update of [{ items: [{ ...items[0], quantity: 2 }] }, { canton: 'San José' }, { shippingType: 'express' }, { uid: 'other' }]) {
    const old = deferred(); const current = deferred(); let call = 0;
    const app = runtime({ tilopayGetQuote: () => (++call === 1 ? old.promise : current.promise) });
    app.render(update);
    old.resolve(quote); await settle(); app.render();
    assert.equal(payButton(app).disabled, true);
    assert.doesNotMatch(app.html(), /Pagás ahora ₡49/);
    current.resolve(quote); await settle(); app.render();
    assert.equal(payButton(app).disabled, false);
    assert.equal(app.quotesShown.at(-1).uid, app.state.uid);
  }
});

test('panel: cotización anterior se oculta al cambiar cantón antes de recibir la nueva', async () => {
  const next = deferred(); let calls = 0;
  const app = await ready({ tilopayGetQuote: () => ++calls === 1 ? Promise.resolve(quote) : next.promise });
  app.render({ canton: 'San José' });
  assert.equal(payButton(app).disabled, true);
  assert.doesNotMatch(app.html(), /₡49\s000/);
  assert.equal(app.quotesShown.at(-1).quote, null);
});

test('panel: error o importe inválido mantiene tarjeta bloqueada y permite recalcular', async () => {
  for (const invalid of [null, { ...quote, crcPayNow: 1 }]) {
    let calls = 0;
    const app = await ready({ tilopayGetQuote: async () => ++calls === 1 ? invalid : quote });
    assert.equal(payButton(app).disabled, true);
    assert.match(app.html(), /role="alert"/);
    await app.button(/Volver a calcular/).onClick(); app.render(); await settle(); app.render();
    assert.equal(payButton(app).disabled, false);
  }
});

test('panel: doble clic inmediato crea un solo pedido, envía quote y conserva identidad antes de llamar pasarela', async () => {
  const creation = deferred(); const charge = deferred();
  const app = await ready({ createPendingOrder: () => creation.promise, tilopayCreatePayment: () => charge.promise });
  const first = payButton(app).onClick(); const second = payButton(app).onClick();
  assert.equal(counts(app, 'createPendingOrder').length, 1);
  creation.resolve({ orderId: 'order-one', orderNumber: 'AP-ONE' }); await settle();
  assert.equal(app.saved().orderId, 'order-one');
  assert.deepEqual(counts(app, 'tilopayCreatePayment')[0].args, [{ orderId: 'order-one', expectedQuote: quote }]);
  charge.resolve({ ...quote, orderId: 'order-one', url: safeUrl }); await Promise.all([first, second]);
  assert.deepEqual(app.redirects, [safeUrl]);
  assert.deepEqual(app.saved().quote, quote);
  assert.ok(!JSON.stringify(app.saved()).includes('https://'));
});

test('panel: cambio de envío mientras se crea el pedido impide iniciar un cobro con cotización vieja', async () => {
  const creation = deferred();
  const app = await ready({ createPendingOrder: () => creation.promise });
  const action = payButton(app).onClick();
  app.render({ shippingType: 'express' });
  creation.resolve({ orderId: 'order-one' }); await action; app.render();
  assert.equal(counts(app, 'tilopayCreatePayment').length, 0);
  assert.equal(app.saved().orderId, 'order-one');
  assert.equal(payButton(app).disabled, true);
  assert.match(app.html(), /Verificá el pedido pendiente/);
});

test('panel: cambiar de cuenta o salir durante creación nunca inicia el pago ni redirige a otra cuenta', async () => {
  for (const change of ['uid', 'unmount']) {
    const creation = deferred();
    const app = await ready({ createPendingOrder: () => creation.promise });
    const action = payButton(app).onClick();
    if (change === 'uid') app.render({ uid: 'other' }); else app.unmount();
    creation.resolve({ orderId: 'order-one' }); await action;
    assert.equal(counts(app, 'tilopayCreatePayment').length, 0);
    assert.deepEqual(app.redirects, []);
  }
});

test('panel: timeout conserva el pedido y reanuda ese mismo aunque falle la cotización del catálogo', async () => {
  const app = await ready({ tilopayCreatePayment: async () => { throw Object.assign(new Error('PRIVATE'), { code: 'functions/unavailable' }); } });
  await payButton(app).onClick(); app.render();
  assert.equal(app.saved().orderId, 'order-one');
  assert.match(app.html(), /Conservamos tu pedido/);
  assert.doesNotMatch(JSON.stringify(app.logs), /PRIVATE/);
  const resumed = await ready({ pending: app.saved(), tilopayGetQuote: async () => { throw new Error('offline'); } });
  assert.equal(payButton(resumed).disabled, false);
  assert.match(resumed.html(), /Pagás ahora ₡49\s000/);
  await payButton(resumed).onClick();
  assert.equal(counts(resumed, 'createPendingOrder').length, 0);
  assert.deepEqual(counts(resumed, 'tilopayCreatePayment')[0].args, [{ orderId: 'order-one', expectedQuote: quote }]);
});

test('panel: otro carrito no continúa el pendiente y otra cuenta nunca recibe su pedido', async () => {
  const changed = await ready({ pending, state: { items: [{ ...items[0], quantity: 2 }] } });
  assert.equal(payButton(changed).disabled, true);
  await payButton(changed).onClick();
  assert.equal(counts(changed, 'tilopayCreatePayment').length, 0);
  const other = await ready({ pending, state: { uid: 'other' } });
  assert.doesNotMatch(other.html(), /Continuar el pedido pendiente|order-one/);
});

test('panel: diferencia del servidor presenta la nueva cotización sin aprobarla automáticamente', async () => {
  const updated = { ...quote, crcSubtotal: 63000, crcTotal: 66000, crcPayNow: 50000 };
  let attempts = 0;
  const app = await ready({ tilopayCreatePayment: async () => {
    if (++attempts === 1) throw Object.assign(new Error('changed'), { code: 'functions/failed-precondition', details: { quote: updated } });
    return { ...updated, orderId: 'order-one', url: safeUrl };
  } });
  await payButton(app).onClick(); app.render();
  assert.deepEqual(app.redirects, []);
  assert.match(app.html(), /Pagás ahora ₡50\s000/);
  assert.match(app.html(), /importe del pedido cambió/);
  await payButton(app).onClick();
  assert.deepEqual(counts(app, 'tilopayCreatePayment')[1].args, [{ orderId: 'order-one', expectedQuote: updated }]);
  assert.equal(counts(app, 'createPendingOrder').length, 1);
  assert.deepEqual(app.redirects, [safeUrl]);
});

test('panel: URL ajena o precio diferente en create no abre una pasarela', async () => {
  for (const response of [{ ...quote, url: 'https://tilopay.com.evil.invalid/pay' },
    { ...quote, crcTotal: 66000, crcSubtotal: 63000, crcPayNow: 50000, url: safeUrl }]) {
    const app = await ready({ tilopayCreatePayment: async () => response });
    await payButton(app).onClick(); app.render();
    assert.deepEqual(app.redirects, []);
    assert.equal(app.saved().orderId, 'order-one');
  }
});

test('panel: pendiente histórico sin quote muestra cobro completo y exige otro clic antes de abrir Tilopay', async () => {
  const legacyQuote = { ...quote, crcPayNow: 65000, crcBalanceDue: 0, crcDepositTotal: 0 };
  const oldPending = { ...pending };
  delete oldPending.quote;
  delete oldPending.quoteKey;
  const app = await ready({ pending: oldPending,
    tilopayCreatePayment: async () => ({ ...legacyQuote, orderId: 'order-one', url: safeUrl }) });
  await payButton(app).onClick(); app.render();
  assert.deepEqual(app.redirects, []);
  assert.match(app.html(), /Pagás ahora ₡65\s000/);
  assert.doesNotMatch(app.html(), /apartado 50%/);
  assert.match(app.html(), /pedidos anteriores conservan su monto original/);
  await payButton(app).onClick();
  assert.deepEqual(counts(app, 'tilopayCreatePayment')[1].args, [{ orderId: 'order-one', expectedQuote: legacyQuote }]);
  assert.deepEqual(app.redirects, [safeUrl]);
});

test('panel: URL válida sin importes verificables solo abre consulta del pedido', async () => {
  const app = await ready({ tilopayCreatePayment: async () => ({ orderId: 'order-one', url: safeUrl, crcTotal: 65000 }) });
  await payButton(app).onClick();
  assert.deepEqual(app.redirects, []);
  assert.deepEqual(app.navigations, [['/tilopay/retorno/order-one']]);
});

test('panel: servidor redirige al pedido equivalente original sin crear otro y verifica paid en retorno', async () => {
  const app = await ready({ tilopayCreatePayment: async () => ({ ...quote, orderId: 'order-original', result: 'already_paid', partial: true }) });
  await payButton(app).onClick();
  assert.deepEqual(app.navigations[0], ['/tilopay/retorno/order-original']);
  assert.equal(app.saved().orderId, 'order-original');
  assert.deepEqual(app.redirects, []);
});

test('retorno: confirma solo orderId autenticado, conserva total completo y apartado; no acredita por URL', async () => {
  const app = await ready({ file: RETURN, pending,
    tilopayConfirm: async args => ({ ...quote, orderId: args.orderId, orderNumber: 'AP-SERVER', result: 'paid', partial: true }) });
  assert.deepEqual(counts(app, 'tilopayConfirm')[0].args, [{ orderId: 'order-one' }]);
  const [url, navigation] = app.navigations[0];
  assert.equal(url, '/orden-confirmada/order-one');
  assert.equal(navigation.state.total, 65000);
  assert.equal(navigation.state.partial, true);
  assert.equal(navigation.state.tilopayQuote.crcPayNow, 49000);
  assert.equal(navigation.state.tilopayQuote.crcBalanceDue, 16000);
  assert.equal(app.clears, 1);
  assert.equal(app.saved(), null);
});

test('retorno: cobro histórico completo conserva el total aunque el servidor no devuelva quote v2', async () => {
  const app = await ready({ file: RETURN, pending,
    tilopayConfirm: async () => ({ orderNumber: 'AP-OLD', result: 'already_paid', crcTotal: 65000 }) });
  assert.equal(app.navigations[0][1].state.partial, false);
  assert.equal(app.navigations[0][1].state.total, 65000);
});

test('retorno: pagar un pedido anterior nunca borra un carrito distinto', async () => {
  const app = await ready({ file: RETURN, pending, state: { items: [{ ...items[0], productId: 'new-cart' }] },
    tilopayConfirm: async () => ({ ...quote, result: 'paid', partial: true }) });
  assert.equal(app.clears, 0);
  assert.equal(app.navigations.length, 1);
});

test('retorno: cambio de identidad u orden descarta confirmaciones tardías y no borra el carrito', async () => {
  for (const update of [{ uid: 'other' }, { orderId: 'another-order' }, { uid: null }]) {
    const old = deferred(); const current = deferred(); let queries = 0;
    const app = runtime({ file: RETURN, pending, tilopayConfirm: () => ++queries === 1 ? old.promise : current.promise });
    app.render(update);
    old.resolve({ ...quote, result: 'paid', partial: true }); await settle(); app.render();
    assert.deepEqual(app.navigations, []);
    assert.equal(app.clears, 0);
    assert.equal(app.saved().uid, 'buyer');
    if (!update.uid && Object.hasOwn(update, 'uid')) assert.match(app.html(), /misma sesión/);
  }
});

test('retorno: sin sesión, autorización pendiente y pago de prueba jamás se convierten en pago confirmado', async () => {
  const loggedOut = await ready({ file: RETURN, state: { uid: null } });
  assert.equal(counts(loggedOut, 'tilopayConfirm').length, 0);
  for (const result of ['pending', 'review', 'test_paid']) {
    const app = await ready({ file: RETURN, pending,
      tilopayConfirm: async () => ({ ...quote, result, message: result === 'pending' ? 'Authorize: captura pendiente' : 'Verificar' }) });
    assert.deepEqual(app.navigations, []);
    assert.equal(app.clears, 0);
    assert.equal(counts(app, 'tilopayCreatePayment').length, 0);
    assert.doesNotMatch(app.html(), /Reintentar el mismo pedido/);
  }
});

test('retorno: solo rechazo con retry explícito permite reintentar el mismo pedido una vez', async () => {
  const without = await ready({ file: RETURN, tilopayConfirm: async () => ({ result: 'declined' }) });
  assert.doesNotMatch(without.html(), /Reintentar el mismo pedido/);
  const payment = deferred();
  const app = await ready({ file: RETURN, pending, tilopayConfirm: async () => ({ result: 'declined', retry: true }),
    tilopayCreatePayment: () => payment.promise });
  const first = app.button(/Reintentar el mismo pedido/).onClick();
  const second = app.button(/Reintentar el mismo pedido/).onClick();
  assert.deepEqual(counts(app, 'tilopayCreatePayment').map(call => call.args), [[{ orderId: 'order-one' }]]);
  payment.resolve({ ...quote, orderId: 'order-one', url: safeUrl }); await Promise.all([first, second]);
  assert.deepEqual(app.redirects, [safeUrl]);
});

test('producto desactivado explica el rechazo y mantiene el pago bloqueado', async () => {
  const app = await ready({ tilopayGetQuote: async () => {
    throw { code: 'functions/invalid-argument', details: { reason: 'CATALOG_UNAVAILABLE', lineIndex: 0 },
      message: 'server arbitrary private text' };
  } });
  assert.match(app.html(), /producto o variante del carrito está desactivado/);
  assert.match(app.html(), /href="\/carrito"/);
  assert.doesNotMatch(app.html(), /arbitrary private/);
  assert.equal(payButton(app).disabled, true);
  assert.equal(counts(app, 'createPendingOrder').length, 0);
  assert.equal(counts(app, 'tilopayCreatePayment').length, 0);
});

test('creación sin formulario conserva pedido y muestra el error antes del retorno', async () => {
  const app = await ready({tilopayCreatePayment:async () => ({...quote, result:'review', formUnavailable:true,
    formReason:'PROVIDER_REJECTED', orderId:'order-one', message:'No se pudo abrir el formulario de Tilopay.'})});
  await payButton(app).onClick(); app.render();
  assert.deepEqual(app.navigations, []); assert.deepEqual(app.redirects, []);
  assert.equal(app.saved().orderId, 'order-one'); assert.match(app.html(), /No se pudo abrir el formulario/);
});

test('retomar un pedido conserva su cotización aunque el catálogo haya cambiado', async () => {
  const app = await ready({pending, tilopayGetQuote:async () => {throw Error('catalog unavailable')}});
  assert.equal(counts(app, 'tilopayGetQuote').length, 0);
  assert.match(app.html(), /Continuar el pedido pendiente/);
  await payButton(app).onClick(); app.render();
  assert.equal(counts(app, 'createPendingOrder').length, 0); assert.deepEqual(app.redirects, [safeUrl]);
});

test('retorno de un pedido sin formulario identifica el fallo de creación y conserva el intento', async () => {
  const app = await ready({ file: RETURN, pending, tilopayConfirm: async () => ({...quote, result:'review',
    formUnavailable:true, retry:false, message:'No se pudo abrir el formulario de Tilopay.'}) });
  assert.match(app.html(), /El formulario de Tilopay no se abrió/);
  assert.doesNotMatch(app.html(), /Tu pago sigue en verificación|Reintentar el mismo pedido/);
  assert.equal(app.saved().orderId, 'order-one'); assert.equal(counts(app,'tilopayCreatePayment').length, 0);
});

test('solo un clic explícito reabre el formulario sandbox del mismo pedido con la cotización confirmada', async () => {
  const app=await ready({file:RETURN,pending,tilopayConfirm:async()=>({...quote,formUnavailable:true,result:'review',testFormGeneration:0}),
    tilopayCreatePayment:async()=>({...quote,orderId:'order-one',url:safeUrl})});
  assert.equal(counts(app,'tilopayCreatePayment').length,0);
  await app.button(/Solicitar formulario de prueba/).onClick();
  assert.deepEqual(counts(app,'tilopayCreatePayment')[0].args,[{orderId:'order-one',retryMissingTestFormGeneration:0}]);
  assert.deepEqual(app.redirects,[safeUrl]);
});
