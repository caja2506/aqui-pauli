// Render source components with React, and exercise the actual Firebase adapter
// and lifecycle callbacks with local doubles. No production writes or auth calls.
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
const SERVICE = 'src/services/giveawayService.js';
const HOOK = 'src/hooks/useGiveaway.js';
const BANNER = 'src/components/storefront/GiveawayBanner.jsx';
const PAGE = 'src/pages/store/GiveawayPage.jsx';
const BASES = 'src/pages/store/GiveawayRulesPage.jsx';
const LOGIN = 'src/components/auth/LoginPage.jsx';
const HOME = 'src/pages/store/HomePage.jsx';
const CATALOG = 'src/pages/store/CatalogPage.jsx';
const ADMIN = 'src/pages/admin/GiveawayAdminPage.jsx';
const APP = 'src/App.jsx';
const SIDEBAR = 'src/components/admin/AdminSidebar.jsx';
const CONFIG = 'functions/lib/giveawayConfig.json';
const POLICY = 'functions/lib/giveawayCatalog.mjs';
const PHONE_POLICY = 'functions/lib/giveawayPhone.mjs';
const PAGE_TITLE = 'src/hooks/usePageTitle.js';
const CATALOG_PRICE = 'functions/lib/catalogPrice.mjs';
const files = [SERVICE, HOOK, BANNER, PAGE, BASES, LOGIN, HOME, CATALOG, ADMIN, APP, SIDEBAR,
  POLICY, PHONE_POLICY, CATALOG_PRICE, 'src/utils/giveawayExport.js', 'src/utils/formatters.js',
  'src/components/legal/LegalLayout.jsx', 'src/components/auth/FacebookIcon.jsx', PAGE_TITLE];
const config = JSON.parse(await readFile(path.join(root, CONFIG), 'utf8'));
const compiled = new Map(await Promise.all(files.map(async (relative) => {
  const filename = path.join(root, relative);
  const result = await transformWithEsbuild(await readFile(filename, 'utf8'), filename, {
    loader: filename.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic', format: 'cjs', target: 'es2022', sourcemap: false,
  });
  return [filename, result.code];
})));
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const contains = (html, value) => assert.ok(plain(html).includes(value), `Missing text: ${value}`);
const user = { uid: 'participant-1', isAnonymous: false, displayName: 'Ana Prueba', email: 'ana@example.invalid' };
const choices = [
  { productId: 'p1', productName: 'Versace Eros EDT 100 ml', productPrice: 47000, variantId: 'v1', variantName: '100 ml' },
  { productId: 'p2', productName: 'Rasasi Hawas Black EDP 100 ml', productPrice: 32000, variantId: 'v2', variantName: '100 ml' },
];
const validForm = {
  fullName: 'Ana Prueba', phone: '88887777', email: user.email, productId: choices[0].productId,
  eligibilityAccepted: true, privacyConsent: true, promotionsConsent: false,
};
const receipt = { campaignId: config.campaignId, number: 12, ...choices[0], prizeLabel: choices[0].productName, createdAt: '2026-10-29T15:00:00.000Z' };
const forbidden = (name) => () => { throw new Error(`Unexpected external operation: ${name}`); };

function runtime(options = {}) {
  const abs = (relative) => path.join(root, relative);
  const cache = new Map();
  const forms = [];
  const links = [];
  const buttons = [];
  const calls = [];
  const snapshots = [];
  const updates = [];
  const queries = [];
  const writes = [];
  const reads = [];
  const inputs = [];
  const selects = [];
  const auth = Object.hasOwn(options, 'user') ? options.user : user;
  const giveaway = { enabled: true, loading: false, error: false, status: 'active', ...options.giveaway };
  const registration = { entry: null, loading: false, error: false, retry: () => {}, ...options.registration };
  const catalog = { products: choices, loading: false, error: false, retry: () => {}, ...options.catalog };
  const modules = new Map([
    [abs(CONFIG), config],
    [abs('src/firebase.js'), { db: {}, functions: {} }],
    [abs('src/contexts/AuthContext.js'), { useAuth: () => ({ user: auth, loading: false, ...options.auth }), socialAuthErrorMessage: forbidden('auth error formatting') }],
    [abs('src/contexts/RoleContext.js'), { useRole: () => ({ isAdmin: true, roleLoading: false, role: 'admin', ...options.role }) }],
    [abs('src/hooks/useAuthFlags.js'), { useAuthFlags: () => ({ facebookEnabled: false }) }],
    [abs('src/services/passwordReset.js'), {
      requestPasswordReset: forbidden('password reset email'),
      passwordResetErrorMessage: forbidden('password reset error formatting'),
      PASSWORD_RESET_SUCCESS: 'Password reset fixture',
    }],
    [abs('src/hooks/useCollection.js'), { useCollection: (collection, queryOptions) => {
      queries.push({ collection, options: queryOptions });
      return { data: [], loading: false, error: false, retry: () => {}, ...options.collection };
    } }],
    ...['ProductCard', 'LoadError', 'EmptyState'].map((name) => [abs(`src/components/${name === 'ProductCard' ? 'storefront' : 'ui'}/${name}.js`), { __esModule: true, default: () => null }]),
    ...['Navbar', 'Footer', 'CartDrawer', 'WhatsAppButton'].map((name) => [abs(`src/components/storefront/${name}.js`), { __esModule: true, default: () => null }]),
    ...['ProductPage', 'CheckoutPage', 'OrderConfirmation', 'TilopayReturnPage', 'MyOrdersPage', 'NotFoundPage']
      .map((name) => [abs(`src/pages/store/${name}.js`), { __esModule: true, default: () => React.createElement('div', null, name) }]),
    ...['DashboardPage', 'BrandsPage', 'CategoriesPage', 'ProductsPage', 'OrdersPage', 'CrmPage', 'ShippingPage']
      .map((name) => [abs(`src/pages/admin/${name}.js`), { __esModule: true, default: () => null }]),
    [abs('src/pages/store/LegalPages.js'), Object.fromEntries(['TerminosPage', 'DevolucionesPage', 'EnviosPage', 'PrivacidadPage'].map((name) => [name, () => null]))],
  ]);
  if (!options.realHooks) modules.set(abs(HOOK), {
    useGiveaway: () => giveaway,
    useGiveawayEntry: (uid) => { options.onEntryUid?.(uid); return registration; },
    useGiveawayProducts: () => catalog,
  });
  let emptyStringSlot = 0;
  const pageReact = {
    ...React,
    useState(initial) {
      let next = initial;
      if (initial && Object.hasOwn(initial, 'fullName') && options.form) next = options.form;
      if (initial && typeof initial === 'object' && Object.keys(initial).length === 0 && options.fieldErrors) next = options.fieldErrors;
      if (initial === null && options.submitted) next = options.submitted;
      if (initial === '' && ++emptyStringSlot === 2 && options.search) next = options.search;
      if (initial === '' && emptyStringSlot === 3 && options.phoneError) next = options.phoneError;
      const [value, setValue] = React.useState(next);
      return [value, (updated) => { updates.push(updated); setValue(updated); }];
    },
  };
  let loginSlot = 0;
  const loginReact = {
    ...React,
    useState(initial) {
      const slot = loginSlot++;
      const values = { 3: user.email, 4: 'test-password-not-a-real-account', 5: user.displayName };
      return React.useState(options.loginValues && Object.hasOwn(values, slot) ? values[slot] : initial);
    },
  };
  const jsx = require('react/jsx-runtime');
  const observeElement = (fn) => (type, props, ...rest) => {
    if (type === 'form') forms.push(props);
    if (type === 'button') buttons.push(props);
    if (type === 'input') inputs.push(props);
    if (type === 'select') selects.push(props);
    if (props?.to) links.push(props);
    return fn(type, props, ...rest);
  };
  const jsxRuntime = { ...jsx, jsx: observeElement(jsx.jsx), jsxs: observeElement(jsx.jsxs) };
  const sdk = {
    doc: (_db, ...parts) => ({ path: parts.join('/') }),
    collection: (_db, ...parts) => ({ path: parts.join('/') }),
    getDocs: async (ref) => {
      reads.push(ref.path);
      if (options.readError?.(ref.path)) throw new Error('Firestore unavailable');
      if (!options.firestore || !Object.hasOwn(options.firestore, ref.path)) return forbidden(`Firestore read ${ref.path}`)();
      return { docs: options.firestore[ref.path].map((data) => ({ id: data.id, data: () => data })) };
    },
    serverTimestamp: () => ({ __serverTimestamp: true }),
    setDoc: async (ref, value, writeOptions) => {
      writes.push({ path: ref.path, value, options: writeOptions });
      if (options.writeError) throw options.writeError;
    },
    onSnapshot: (ref, onValue, onError) => {
      const subscription = { ref, onValue, onError, unsubscribed: false };
      snapshots.push(subscription);
      return () => { subscription.unsubscribed = true; };
    },
  };
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    assert.ok(compiled.has(filename), `Unexpected source import: ${path.relative(root, filename)}`);
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = (name) => {
      if (name === 'react' && filename === abs(PAGE_TITLE) && options.pageTitleEffects) {
        return { ...React, useEffect: (effect) => options.pageTitleEffects.push(effect) };
      }
      if (name === 'react') return filename === abs(HOOK) && options.hookReact ? options.hookReact
        : filename === abs(PAGE) || filename === abs(ADMIN) ? pageReact : filename === abs(LOGIN) ? loginReact : React;
      if (name === 'react/jsx-runtime') return jsxRuntime;
      if (name === 'react-router-dom') {
        const router = require(name);
        // Use the real route tree against MemoryRouter instead of accessing a
        // browser history during SSR. Other route and navigation behavior stays real.
        return { ...router, ...(filename === abs(APP) ? { BrowserRouter: ({ children }) => children } : {}),
          ...(filename === abs(LOGIN) && options.navigate ? { useNavigate: () => options.navigate } : {}) };
      }
      if (name === 'lucide-react') return require(name);
      if (name === 'firebase/firestore') return sdk;
      if (name === 'firebase/functions') return {
        httpsCallable: (_functions, callableName) => async (payload) => {
          calls.push({ callableName, payload });
          if (!options.call) return forbidden('callable invocation')();
          return options.call(payload);
        },
      };
      assert.ok(name.startsWith('.'), `Unexpected external import: ${name}`);
      const target = path.resolve(path.dirname(filename), name);
      const candidates = path.extname(target) ? [target] : [`${target}.js`, `${target}.jsx`];
      const found = candidates.find((candidate) => modules.has(candidate) || compiled.has(candidate));
      assert.ok(found, `Unresolved import ${name} in ${filename}`);
      return load(found);
    };
    new Function('require', 'module', 'exports', compiled.get(filename))(localRequire, module, module.exports);
    return module.exports;
  }
  function render(relative = PAGE, { exportName = 'default', props = {}, locationState = null, pathname = '/sorteo' } = {}) {
    const Component = load(abs(relative))[exportName];
    return renderToStaticMarkup(React.createElement(MemoryRouter, {
      initialEntries: [{ pathname, state: locationState }],
    }, React.createElement(Component, props)));
  }
  return { render, load: (relative) => load(abs(relative)), forms, links, buttons, calls, snapshots, updates, queries, writes, reads, inputs, selects };
}

test('la ruta del sorteo usa su título propio y lo restaura al salir', () => {
  const effects = [];
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const previousDocument = globalThis.document;
  try {
    globalThis.document = { title: 'Página anterior | Aquí Pauli' };
    runtime({ pageTitleEffects: effects }).render();
    assert.equal(effects.length, 1);
    const cleanup = effects[0]();
    assert.equal(globalThis.document.title, 'Sorteo | Aquí Pauli');
    cleanup();
    assert.equal(globalThis.document.title, 'Página anterior | Aquí Pauli');
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }
});

test('banner exacto, rosado y enlazado a la inscripción', () => {
  const html = runtime().render(BANNER);
  contains(html, '🎁 Sorteo: ganá la colonia que querás (hasta ₡50 000) — Participar');
  assert.match(html, /href="\/sorteo"/);
  assert.match(html, /bg-rose-100/);
});

test('el banner aparece en home y catálogo reales', () => {
  for (const page of [HOME, CATALOG]) assert.match(runtime().render(page), /data-testid="giveaway-banner"/);
});

test('banner oculto durante carga, error, pausa, antes de inicio y después del cierre', () => {
  for (const giveaway of [{ loading: true }, { error: true }, { status: 'disabled' }, { status: 'upcoming' }, { status: 'closed' }]) {
    assert.equal(runtime({ giveaway }).render(BANNER), '');
  }
});

test('fechas compartidas abren a medianoche CR y cierran exactamente a las 20:00 CR', () => {
  const { giveawayStatus } = runtime().load(SERVICE);
  const start = Date.parse('2026-10-29T00:00:00-06:00');
  const end = Date.parse('2026-11-28T20:00:00-06:00');
  assert.equal(Date.parse(config.startsAt), start);
  assert.equal(Date.parse(config.endsAt), end);
  assert.equal(giveawayStatus(true, start - 1), 'upcoming');
  assert.equal(giveawayStatus(true, start), 'active');
  // La fecha anterior de cierre debe conservar banner e inscripción abiertos.
  const formerEnd = Date.parse('2026-11-05T20:00:00-06:00');
  for (const now of [formerEnd, formerEnd + 1, end - 1]) {
    const status = giveawayStatus(true, now);
    assert.equal(status, 'active');
    assert.match(runtime({ giveaway: { status } }).render(BANNER), /data-testid="giveaway-banner"/);
  }
  assert.equal(giveawayStatus(true, end - 1), 'active');
  assert.equal(giveawayStatus(true, end), 'closed');
  assert.equal(giveawayStatus(true, end + 1), 'closed');
  assert.equal(runtime({ giveaway: { status: giveawayStatus(true, end) } }).render(BANNER), '');
  assert.equal(giveawayStatus(false, start + 1), 'disabled');
});

test('usuarios sin cuenta y anónimos deben registrarse con retorno a /sorteo', () => {
  for (const authUser of [null, { ...user, isAnonymous: true }]) {
    const seen = [];
    const app = runtime({ user: authUser, onEntryUid: (uid) => seen.push(uid) });
    const html = app.render();
    assert.match(html, /data-testid="giveaway-auth-required"/);
    assert.doesNotMatch(html, /data-testid="giveaway-form"/);
    assert.deepEqual(seen, [null]);
    assert.deepEqual(app.links.find((link) => link.state?.mode === 'register').state, { from: '/sorteo', mode: 'register' });
    assert.equal(app.links.find((link) => link.children === 'Ya tengo cuenta: iniciar sesión').state.from, '/sorteo');
  }
});

test('el login existente abre registro para el sorteo y conserva login por defecto', () => {
  const forGiveaway = runtime().render(LOGIN, { locationState: { from: '/sorteo', mode: 'register' } });
  assert.match(forGiveaway, /placeholder="Tu nombre"/);
  assert.doesNotMatch(runtime().render(LOGIN), /placeholder="Tu nombre"/);
});

test('formulario muestra selector buscable, nombres y precios, correo de cuenta y consentimiento separado', () => {
  const html = runtime().render();
  contains(html, 'sábado 28 de noviembre de 2026 a las 8:00 p. m.');
  contains(html, 'El sorteo será el domingo 29 de noviembre de 2026.');
  assert.match(html, /data-testid="giveaway-form"/);
  const nameInput = html.match(/<input[^>]*name="fullName"[^>]*>/)?.[0];
  assert.match(nameInput, /required=""/);
  assert.match(nameInput, /value="Ana Prueba"/);
  const phoneInput = html.match(/<input[^>]*name="phone"[^>]*>/)?.[0];
  assert.match(phoneInput, /required=""/);
  assert.doesNotMatch(phoneInput, /maxLength=|pattern=/);
  contains(html, 'Podés pegar el número con +506 o 506, espacios o guiones.');
  const emailInput = html.match(/<input[^>]*name="email"[^>]*>/)?.[0];
  assert.match(emailInput, /readOnly=""/);
  assert.match(emailInput, /value="ana@example.invalid"/);
  for (const product of choices) contains(html, product.productName);
  const select = html.match(/<select[^>]*name="productId"[^>]*>/)?.[0];
  assert.match(select, /required=""/);
  assert.match(html, /id="giveaway-search"[^>]*type="search"/);
  contains(html, '₡47 000');
  contains(html, '₡32 000');
  contains(html, 'Los productos de ₡50 000 o más no califican.');
  assert.doesNotMatch(html, /name="prizeId"/);
  for (const name of ['eligibilityAccepted', 'privacyConsent']) {
    const input = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
    assert.match(input, /required=""/);
    assert.doesNotMatch(input, /checked=""/);
  }
  const promotions = html.match(/<input[^>]*name="promotionsConsent"[^>]*>/)?.[0];
  assert.doesNotMatch(promotions, /required|checked/);
  contains(html, config.eligibilityText);
  contains(html, config.privacyConsentText);
  contains(html, 'Opcional. Tu decisión no cambia tu participación en el sorteo.');
  assert.match(html, /href="\/sorteo\/bases"/);
  assert.match(html, /pb-\[calc\(7rem\+env\(safe-area-inset-bottom,0px\)\)\]/);
});

const validPhoneCases = [
  ...['2', '4', '5', '6', '7', '8'].map((start) => [`${start}1234567`, `${start}1234567`]),
  ['8888-7777', '88887777'], [' 8888 7777 ', '88887777'],
  ['+506 8888-7777', '88887777'], ['506 8888-7777', '88887777'],
  ['+506\u00a08888\u00a07777', '88887777'],
  ['50612345', '50612345'], ['5061-2345', '50612345'],
  ['+506 5061-2345', '50612345'], ['506 5061-2345', '50612345'],
];
const invalidPhones = [
  '', '8888777', '888877777', '8888777711', '5068888777', '8888-77777', '8888a7777', '(8888)7777', '8888.7777',
  ...['0', '1', '3', '9'].map((start) => `${start}1234567`),
  '+506 888877777', '506 888877777', '+506 8888777711', '506 8888777711', '+506 506 88887777', '50650688887777',
  '+506 +506 88887777', '+507 88887777', '00506 88887777',
];
const phoneTarget = (value) => ({ value, message: '', setCustomValidity(message) { this.message = message; } });
const lastFormUpdate = (app, current) => app.updates.filter((value) => typeof value === 'function').at(-1)(current);

test('pegar teléfonos con formato guarda 8 dígitos completos y conserva los locales que empiezan 506', () => {
  for (const [raw, expected] of validPhoneCases) {
    const app = runtime({ form: validForm });
    app.render();
    const input = app.inputs.find((candidate) => candidate.name === 'phone');
    const target = phoneTarget(raw);
    input.onChange({ currentTarget: target });
    assert.equal(lastFormUpdate(app, validForm).phone, expected, raw);
    assert.equal(target.message, '', raw);
    assert.equal(app.calls.length, 0);
  }
});

test('teléfonos inválidos no pierden dígitos ni letras al pegar o repetir blur e invalid', () => {
  for (const raw of invalidPhones) {
    const app = runtime({ form: validForm });
    const { GIVEAWAY_PHONE_ERROR } = app.load(PHONE_POLICY);
    app.render();
    const input = app.inputs.find((candidate) => candidate.name === 'phone');
    const target = phoneTarget(raw);
    let form = validForm;
    for (const handler of [input.onChange, input.onBlur, input.onBlur, input.onInvalid]) {
      handler({ currentTarget: target });
      form = lastFormUpdate(app, form);
      assert.equal(form.phone, raw, raw);
      assert.equal(target.message, GIVEAWAY_PHONE_ERROR, raw);
      target.value = form.phone;
    }
    assert.ok(app.updates.includes(GIVEAWAY_PHONE_ERROR));
    assert.equal(app.calls.length, 0);
  }
});

test('el envío valida el teléfono aun sin blur y nunca llama al servidor si es inválido', async () => {
  for (const phone of invalidPhones) {
    const app = runtime({ form: { ...validForm, phone } });
    const { GIVEAWAY_PHONE_ERROR } = app.load(PHONE_POLICY);
    app.render();
    await app.forms[0].onSubmit({ preventDefault() {} });
    assert.equal(app.calls.length, 0, phone);
    assert.ok(app.updates.includes(GIVEAWAY_PHONE_ERROR), phone);
  }
});

test('el envío acepta el formato permitido sin blur y manda el mismo teléfono canónico del servidor', async () => {
  for (const [phone, expected] of validPhoneCases) {
    const app = runtime({ form: { ...validForm, phone }, call: async () => ({ data: receipt }) });
    app.render();
    await app.forms[0].onSubmit({ preventDefault() {} });
    assert.equal(app.calls.length, 1, phone);
    assert.deepEqual(app.calls[0], { callableName: 'enterGiveaway', payload: { ...validForm, phone: expected } });
  }
});

test('el error del teléfono es visible, está asociado al campo y se limpia al corregir el número', () => {
  const { GIVEAWAY_PHONE_ERROR } = runtime().load(PHONE_POLICY);
  const app = runtime({ form: { ...validForm, phone: '888877777' }, phoneError: GIVEAWAY_PHONE_ERROR });
  const html = app.render();
  contains(html, GIVEAWAY_PHONE_ERROR);
  assert.match(html, /id="giveaway-phone-error" role="alert"/);
  const field = html.match(/<input[^>]*name="phone"[^>]*>/)?.[0];
  assert.match(field, /aria-invalid="true"/);
  assert.match(field, /aria-describedby="giveaway-phone-help giveaway-phone-error"/);
  const target = phoneTarget('+506 8888-7777');
  app.inputs.find((candidate) => candidate.name === 'phone').onChange({ currentTarget: target });
  assert.equal(target.message, '');
  assert.ok(app.updates.includes(''));
  assert.equal(lastFormUpdate(app, validForm).phone, '88887777');
});

test('un intento incompleto explica todos los campos y casillas pendientes sin llamar al servidor', async () => {
  const form = { ...validForm, fullName: '', phone: '8888777711', email: 'sin-correo', productId: '',
    eligibilityAccepted: false, privacyConsent: false };
  const app = runtime({ user: { ...user, email: null }, form });
  const html = app.render();
  assert.match(html, /<form[^>]*noValidate=""/);
  assert.equal(findButton(app, 'Participar en el sorteo').disabled, false);
  const focused = [];
  await app.forms[0].onSubmit({ preventDefault() {}, currentTarget: {
    elements: { namedItem: (name) => ({ focus: () => focused.push(name) }) },
  } });
  assert.deepEqual(focused, ['fullName']);
  assert.equal(app.calls.length, 0);
  const fieldErrors = app.updates.find((value) => value && typeof value === 'object');
  assert.deepEqual(Object.keys(fieldErrors).sort(), ['email', 'eligibilityAccepted', 'fullName', 'privacyConsent', 'productId'].sort());
  const { GIVEAWAY_PHONE_ERROR } = app.load(PHONE_POLICY);
  assert.ok(app.updates.includes(GIVEAWAY_PHONE_ERROR));
  const shown = runtime({ user: { ...user, email: null }, form, fieldErrors, phoneError: GIVEAWAY_PHONE_ERROR }).render();
  contains(shown, 'Revisá estos datos antes de participar:');
  assert.match(shown, /name="phone"[^>]*value="8888777711"/);
  for (const id of ['name', 'phone', 'email', 'product', 'eligibility', 'privacy']) {
    assert.match(shown, new RegExp(`href="#giveaway-${id}"`));
    assert.match(shown, new RegExp(`id="giveaway-${id}-error"`));
    const field = shown.match(new RegExp(`<(?:input|select)[^>]*id="giveaway-${id}"[^>]*>`))?.[0];
    assert.match(field, /aria-invalid="true"/);
    assert.ok(field.includes(`giveaway-${id}-error`));
  }
});

test('cada casilla obligatoria explica el error, recibe foco y bloquea el envío', async () => {
  for (const [name, id, expectedText] of [
    ['eligibilityAccepted', 'eligibility', 'mayor de 18 años'],
    ['privacyConsent', 'privacy', 'uso de tus datos'],
  ]) {
    const form = { ...validForm, [name]: false };
    const app = runtime({ form });
    app.render();
    assert.equal(findButton(app, 'Participar en el sorteo').disabled, false);
    const focused = [];
    await app.forms[0].onSubmit({ preventDefault() {}, currentTarget: {
      elements: { namedItem: (field) => ({ focus: () => focused.push(field) }) },
    } });
    assert.deepEqual(focused, [name]);
    assert.equal(app.calls.length, 0);
    const fieldErrors = app.updates.find((value) => value && typeof value === 'object');
    assert.deepEqual(Object.keys(fieldErrors), [name]);
    assert.ok(fieldErrors[name].includes(expectedText));
    const errored = runtime({ form, fieldErrors });
    const shown = errored.render();
    contains(shown, expectedText);
    const field = shown.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
    assert.match(field, new RegExp(`aria-describedby="giveaway-${id}-error"`));
    const checkbox = errored.inputs.find((input) => input.name === name);
    checkbox.onChange({ target: { checked: true } });
    const updates = errored.updates.filter((value) => typeof value === 'function');
    assert.equal(updates[0](fieldErrors)[name], '');
    const correctedForm = updates.at(-1)(form);
    const corrected = runtime({ form: correctedForm, call: async () => ({ data: receipt }) });
    corrected.render();
    await corrected.forms[0].onSubmit({ preventDefault() {} });
    assert.equal(corrected.calls.length, 1);
    assert.equal(corrected.calls[0].payload.promotionsConsent, false);
  }
});

test('el correo puede completarse cuando el proveedor de cuenta no lo entrega', () => {
  const html = runtime({ user: { ...user, email: null } }).render();
  const input = html.match(/<input[^>]*name="email"[^>]*>/)?.[0];
  assert.match(input, /required=""/);
  assert.doesNotMatch(input, /readOnly=""/);
});

test('participación guardada reemplaza formulario por número y premio incluso después del cierre', () => {
  for (const giveaway of [{}, { status: 'closed' }, { status: 'disabled' }, { error: true }]) {
    const html = runtime({ giveaway, registration: { entry: receipt } }).render();
    contains(html, '¡Ya estás participando!');
    contains(html, 'Tu número de participante es #12');
    contains(html, receipt.productName);
    assert.doesNotMatch(html, /data-testid="giveaway-form"/);
  }
});

test('el resultado del servidor se muestra de inmediato y no cruza cuentas', () => {
  const html = runtime({ submitted: { uid: user.uid, entry: receipt } }).render();
  assert.match(html, /data-testid="giveaway-receipt"/);
  const other = runtime({ submitted: { uid: 'someone-else', entry: receipt } }).render();
  assert.doesNotMatch(other, /data-testid="giveaway-receipt"/);
});

test('la página bloquea inscripción al cerrar, pausar o fallar lecturas', () => {
  for (const options of [
    { giveaway: { status: 'closed' } }, { giveaway: { status: 'disabled' } },
    { giveaway: { status: 'upcoming' } }, { giveaway: { error: true } },
    { registration: { error: true } }, { registration: { loading: true } }, { auth: { loading: true } },
  ]) {
    const html = runtime(options).render();
    assert.doesNotMatch(html, /data-testid="giveaway-form"/);
    if (options.giveaway?.status === 'closed') {
      contains(html, 'Las inscripciones al sorteo cerraron el sábado 28 de noviembre de 2026 a las 8:00 p. m., hora de Costa Rica.');
    }
  }
});

test('doble clic usa una sola llamada y devuelve el número sin inventarlo en cliente', async () => {
  let complete;
  const entered = [];
  const app = runtime({ form: validForm, call: () => new Promise((resolve) => { complete = resolve; }) });
  app.render(PAGE, { exportName: 'GiveawayForm', props: { user, onEntered: (value) => entered.push(value) } });
  const submit = app.forms[0].onSubmit;
  const first = submit({ preventDefault() {} });
  await submit({ preventDefault() {} });
  assert.equal(app.calls.length, 1);
  assert.deepEqual(app.calls[0], { callableName: 'enterGiveaway', payload: validForm });
  complete({ data: receipt });
  await first;
  assert.deepEqual(entered, [receipt]);
});

test('un resultado repetido usa el mismo número y una falla permite reintento seguro', async () => {
  let attempt = 0;
  const entered = [];
  const app = runtime({ form: validForm, call: async () => {
    if (attempt++ === 0) throw { code: 'functions/unavailable' };
    return { data: { ...receipt, alreadyEntered: true } };
  } });
  app.render(PAGE, { exportName: 'GiveawayForm', props: { user, onEntered: (value) => entered.push(value) } });
  await app.forms[0].onSubmit({ preventDefault() {} });
  assert.equal(entered.length, 0);
  assert.ok(app.updates.some((value) => typeof value === 'string' && value.includes('tu cuenta solo puede recibir un número')));
  await app.forms[0].onSubmit({ preventDefault() {} });
  assert.equal(entered[0].number, 12);
  assert.equal(entered[0].alreadyEntered, true);
});

test('servicio envía solo campos autorizados y rechaza una respuesta sin número válido', async () => {
  const app = runtime({ call: async () => ({ data: { ...receipt, number: -1 } }) });
  await assert.rejects(app.load(SERVICE).enterGiveaway({ ...validForm, uid: 'victim', number: 1, createdAt: 'forged',
    productName: 'Otro premio', productPrice: 1, variantId: 'cheap', prizeId: 'legacy' }), /confirmar tu número/);
  assert.deepEqual(app.calls[0].payload, validForm);
});

test('adaptadores escuchan solo flag público y documento del usuario indicado', () => {
  const app = runtime();
  const service = app.load(SERVICE);
  const values = [];
  const entries = [];
  const stop = service.watchGiveawayConfig((value) => values.push(value), () => {});
  const ownStop = service.watchOwnGiveawayEntry(user.uid, (entry) => entries.push(entry), () => {});
  assert.deepEqual(app.snapshots.map((s) => s.ref.path), ['config/giveaway', `giveawayEntries/${user.uid}`]);
  app.snapshots[0].onValue({ exists: () => false });
  app.snapshots[0].onValue({ exists: () => true, data: () => ({ enabled: false }) });
  app.snapshots[0].onValue({ exists: () => true, data: () => ({ enabled: true }) });
  assert.deepEqual(values, [true, false, true]);
  app.snapshots[1].onValue({ exists: () => true, data: () => receipt });
  app.snapshots[1].onValue({ exists: () => false });
  assert.deepEqual(entries, [receipt, null]);
  stop(); ownStop();
  assert.ok(app.snapshots.every((s) => s.unsubscribed));
});

test('hook falla cerrado, escucha el flag y limpia la suscripción', () => {
  const effects = [];
  const states = [];
  const hookReact = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, (next) => states.push(next)],
    useEffect: (effect) => effects.push(effect),
  };
  const app = runtime({ realHooks: true, hookReact });
  const initial = app.load(HOOK).useGiveaway();
  assert.equal(initial.loading, true);
  assert.equal(initial.isOpen, false);
  const cleanup = effects[0]();
  app.snapshots[0].onValue({ exists: () => true, data: () => ({ enabled: true }) });
  assert.deepEqual(states.at(-1), { enabled: true, loading: false, error: false });
  app.snapshots[0].onError(new Error('offline'));
  assert.deepEqual(states.at(-1), { enabled: false, loading: false, error: true });
  cleanup();
  assert.equal(app.snapshots[0].unsubscribed, true);
});

test('hook programa el cierre y vuelve a consultar la hora al recuperar foco', () => {
  const effects = [];
  const states = [];
  const now = Date.parse(config.endsAt) - 25;
  let slot = 0;
  const app = runtime({ realHooks: true, hookReact: {
    useState: (initial) => [slot++ === 1 ? now : typeof initial === 'function' ? initial() : initial, (next) => states.push(next)],
    useEffect: (effect) => effects.push(effect),
  } });
  app.load(HOOK).useGiveaway();
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const listeners = new Map();
  let delay;
  let timer;
  let cleared = false;
  globalThis.window = {
    setTimeout: (callback, ms) => { timer = callback; delay = ms; return 5; },
    clearTimeout: (id) => { assert.equal(id, 5); cleared = true; },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  };
  globalThis.document = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  };
  try {
    const cleanup = effects[1]();
    assert.equal(delay, 25);
    timer(); listeners.get('focus')(); listeners.get('visibilitychange')();
    assert.equal(states.length, 3);
    assert.ok(states.every(Number.isFinite));
    cleanup();
    assert.equal(cleared, true);
    assert.equal(listeners.size, 0);
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  }
});

test('bases muestran período CR, catálogo elegible, instrucción Instagram y derechos', () => {
  const html = runtime().render(BASES);
  for (const value of ['29 de octubre de 2026', 'sábado 28 de noviembre de 2026', 'domingo 29 de noviembre de 2026', '8:00 p. m.', 'Costa Rica (UTC−6)',
    'Carlos Jiménez Arias', 'San José de Grecia', 'Firebase', 'Ley 8968', '@aqui.paulina', 'rectificación', 'promociones']) contains(html, value);
  contains(html, 'inferior a ₡50 000');
  contains(html, 'con stock, bajo pedido o sin stock');
  contains(html, 'comentá tu número de participante');
  assert.doesNotMatch(html, /Light Blue Mujer|Acqua di Giò/);
  assert.match(html, /href="\/sorteo"/);
});

const buttonText = (children) => React.Children.toArray(children).map((child) => typeof child === 'object'
  ? buttonText(child.props?.children) : String(child)).join('');
const findButton = (app, label) => {
  const button = app.buttons.find((candidate) => buttonText(candidate.children).includes(label));
  assert.ok(button, `Missing button: ${label}`);
  return button;
};
const participant = (overrides = {}) => ({
  ...receipt, id: 'participant-1', uid: 'participant-1', fullName: 'Ana Prueba', phone: '88887777',
  email: 'ana@example.invalid', prizeLabel: receipt.productName,
  createdAt: { seconds: Date.parse('2026-10-30T02:00:00.000Z') / 1000 }, promotionsConsent: false, ...overrides,
});

test('admin no consulta participantes mientras verifica el rol ni para usuarios sin permiso', () => {
  for (const role of [{ roleLoading: true }, { isAdmin: false, role: 'cliente' }]) {
    const app = runtime({ role });
    const html = app.render(ADMIN);
    assert.equal(app.queries.length, 0);
    assert.equal(app.writes.length, 0);
    assert.doesNotMatch(html, /Exportar CSV|ana@example.invalid/);
    contains(html, role.roleLoading ? 'Verificando acceso' : 'Acceso reservado a administradores.');
  }
});

test('admin muestra datos de la campaña, hora CR y autorizaciones de promociones separadas', () => {
  const data = [participant(), participant({ id: 'participant-2', number: 13, fullName: 'Beatriz Prueba', promotionsConsent: true }),
    participant({ id: 'old', campaignId: 'other-campaign', number: 666, fullName: 'No debe aparecer' })];
  const app = runtime({ collection: { data } });
  const html = app.render(ADMIN);
  contains(html, 'sábado 28 de noviembre de 2026 a las 8:00 p. m. de Costa Rica.');
  contains(html, 'El sorteo será el domingo 29 de noviembre de 2026.');
  assert.deepEqual(app.queries, [{ collection: 'giveawayEntries', options: { orderByField: 'number', orderDirection: 'asc' } }]);
  for (const value of ['Participantes (2)', '#12', '#13', 'Ana Prueba', 'Beatriz Prueba', '+506 88887777', 'ana@example.invalid',
    receipt.productName, '₡47 000', '29/10/2026', '20:00:00', 'Fecha (Costa Rica)', 'Promociones']) contains(html, value);
  assert.match(html, /<td[^>]*>Sí<\/td>/);
  assert.match(html, /<td[^>]*>No<\/td>/);
  assert.doesNotMatch(html, /#666|No debe aparecer/);
  assert.equal(findButton(app, 'Exportar CSV').disabled, false);
});

test('admin deshabilita exportación durante carga, error y listas vacías', () => {
  for (const collection of [{ loading: true, data: [participant()] }, { error: true, data: [participant()] }, { data: [] }]) {
    const app = runtime({ collection });
    const html = app.render(ADMIN);
    assert.equal(findButton(app, 'Exportar CSV').disabled, true);
    const message = collection.loading ? 'Cargando participantes' : collection.error ? 'No se pudo cargar la lista de participantes.' : 'Todavía no hay participantes registrados.';
    contains(html, message);
    assert.doesNotMatch(html, /<table/);
  }
  const hiddenOnly = runtime({ collection: { data: [participant({ campaignId: 'old-campaign' })] } });
  hiddenOnly.render(ADMIN);
  assert.equal(findButton(hiddenOnly, 'Exportar CSV').disabled, true);
});

test('interruptor admin solo escribe enabled y timestamp en config/giveaway sin sustituir otros campos', async () => {
  for (const enabled of [true, false]) {
    const app = runtime({ giveaway: { enabled, status: enabled ? 'active' : 'disabled' } });
    app.render(ADMIN);
    const button = findButton(app, enabled ? 'Apagar sorteo' : 'Encender sorteo');
    await button.onClick();
    assert.deepEqual(app.writes, [{ path: 'config/giveaway', value: { enabled: !enabled, updatedAt: { __serverTimestamp: true } }, options: { merge: true } }]);
  }
  for (const giveaway of [{ loading: true }, { error: true }]) {
    const app = runtime({ giveaway });
    app.render(ADMIN);
    const button = findButton(app, 'Apagar sorteo');
    assert.equal(button.disabled, true);
    await button.onClick();
    assert.deepEqual(app.writes, []);
  }
});

test('fallo al apagar muestra mensaje y permite continuar sin modificar participantes', async () => {
  const app = runtime({ writeError: new Error('permission denied') });
  app.render(ADMIN);
  await findButton(app, 'Apagar sorteo').onClick();
  assert.ok(app.updates.some((value) => typeof value === 'string' && value.includes('No se pudo cambiar el estado')));
  assert.equal(app.updates.at(-1), false);
  assert.equal(app.writes[0].path, 'config/giveaway');
});

test('exportar usa el CSV real de la campaña y descarga sin enviar información a otros servicios', async () => {
  const app = runtime({ collection: { data: [participant(), participant({ id: 'old', campaignId: 'old', fullName: 'Excluida' })] } });
  app.render(ADMIN);
  const previous = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL, timeout: globalThis.setTimeout };
  let blob;
  let clicked = false;
  let appended = false;
  let removed = false;
  let cleanup;
  let revoked;
  const anchor = { click() { clicked = true; }, remove() { removed = true; } };
  globalThis.document = {
    createElement: (tag) => { assert.equal(tag, 'a'); return anchor; },
    body: { appendChild: (element) => { assert.equal(element, anchor); appended = true; } },
  };
  URL.createObjectURL = (value) => { blob = value; return 'blob:local-test'; };
  URL.revokeObjectURL = (url) => { revoked = url; };
  globalThis.setTimeout = (callback) => { cleanup = callback; return 1; };
  try {
    findButton(app, 'Exportar CSV').onClick();
    assert.equal(blob.type, 'text/csv;charset=utf-8;');
    const csv = await blob.text();
    assert.match(csv, /"Ana Prueba","88887777","ana@example.invalid"/);
    assert.match(csv, /"Promociones autorizadas"/);
    assert.doesNotMatch(csv, /Excluida/);
    assert.equal(anchor.download, `sorteo-${config.campaignId}.csv`);
    assert.equal(anchor.href, 'blob:local-test');
    assert.ok(clicked && appended && removed);
    cleanup();
    assert.equal(revoked, 'blob:local-test');
    assert.equal(app.writes.length, 0);
    assert.equal(app.calls.length, 0);
  } finally {
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    URL.createObjectURL = previous.create;
    URL.revokeObjectURL = previous.revoke;
    globalThis.setTimeout = previous.timeout;
  }
});

test('rutas de App montan inscripción, bases y administración reales con el enlace de sidebar', () => {
  const storefront = runtime().render(APP, { pathname: '/sorteo' });
  assert.match(storefront, /data-testid="giveaway-form"/);
  contains(runtime().render(APP, { pathname: '/sorteo/bases' }), 'Bases del sorteo de Aquí Pauli');
  const admin = runtime().render(APP, { pathname: '/admin/sorteo' });
  contains(admin, 'Todavía no hay participantes registrados.');
  assert.match(admin, /href="\/admin\/sorteo"/);
  const denied = runtime({ role: { isAdmin: false, role: 'cliente' } });
  contains(denied.render(APP, { pathname: '/admin/sorteo' }), 'Acceso Denegado');
  assert.equal(denied.queries.length, 0);
});

test('registro del login existente vuelve a /sorteo después de crear la cuenta', async () => {
  const accounts = [];
  const navigations = [];
  const app = runtime({ user: null, loginValues: true,
    auth: { createAccount: async (...args) => { accounts.push(args); } },
    navigate: (...args) => navigations.push(args),
  });
  app.render(APP, { pathname: '/login', locationState: { from: '/sorteo', mode: 'register' } });
  await app.forms[0].onSubmit({ preventDefault() {} });
  assert.deepEqual(accounts, [[user.email, 'test-password-not-a-real-account', user.displayName]]);
  assert.deepEqual(navigations, [['/sorteo', { replace: true }]]);
});

const fragranceCategories = [{ id: 'fragrance', name: 'Perfumes' },
  { id: 'men', name: 'Hombres', parentId: 'fragrance' }, { id: 'bags', name: 'Bolsos' }];
const catalogFixture = () => ({
  products: [
    { id: 'p1', name: choices[0].productName, active: true, basePrice: 60000, categoryRefs: [{ id: 'men', path: 'categories/men' }] },
    { id: 'p2', name: choices[1].productName, active: true, basePrice: 32000, categoryRefs: [{ id: 'fragrance' }] },
    { id: 'limit', name: 'Colonia en el límite', active: true, basePrice: 100, categoryIds: ['fragrance'] },
    { id: 'rounded', name: 'Precio mostrado al límite', active: true, basePrice: 49999.5, categoryIds: ['fragrance'] },
    { id: 'base-only', name: 'Sin variantes', active: true, basePrice: 49999, categoryIds: ['fragrance'] },
    { id: 'bag', name: 'Perfume en nombre pero es un bolso', active: true, basePrice: 100, categoryIds: ['bags'] },
    { id: 'inactive', name: 'Inactiva', active: false, basePrice: 100, categoryIds: ['fragrance'] },
    { id: 'deleted', name: 'Eliminada', active: true, deleted: true, basePrice: 100, categoryIds: ['fragrance'] },
    { id: 'unlisted', name: 'Oculta', active: true, unlisted: true, basePrice: 100, categoryIds: ['fragrance'] },
  ],
  categories: fragranceCategories,
  'products/p1/variants': [{ id: 'v1', active: true, price: 47000, stock: 0, commercialStatus: 'no_disponible' }],
  'products/p2/variants': [{ id: 'v2', active: true, price: 32000, stock: 0, supplyType: 'bajo_pedido' }],
  'products/limit/variants': [{ id: 'v3', active: true, price: 50000 }],
  'products/rounded/variants': [],
  'products/base-only/variants': [],
});

test('catálogo Firestore usa política compartida, precio de venta y no exige stock', async () => {
  const app = runtime({ firestore: catalogFixture() });
  const products = await app.load(SERVICE).loadGiveawayProducts();
  assert.deepEqual(products.map((product) => [product.productId, product.productPrice]), [
    ['p2', 32000], ['base-only', 49999], ['p1', 47000],
  ]);
  assert.equal(products.find((product) => product.productId === 'p1').productName, choices[0].productName);
  assert.deepEqual(app.reads.slice(0, 2).sort(), ['categories', 'products']);
  assert.equal(app.reads.length, 7);
  assert.ok(app.reads.every((read) => !/bag\/variants|inactive\/variants|deleted\/variants|unlisted\/variants/.test(read)));
});

test('el selector muestra el mínimo válido de variantes activas sin sustituir un precio cero por el precio base', async () => {
  const fixture = catalogFixture();
  fixture['products/p1/variants'] = [
    { id: 'first', active: true, price: 62000, order: 0 },
    { id: 'inactive', active: false, price: 1000, order: 1 },
    { id: 'deleted', active: true, deleted: true, price: 1000, order: 2 },
    { id: 'invalid', active: true, price: '1000x', order: 3 },
    { id: 'minimum', active: true, price: 45000, order: 4, stock: 0, supplyType: 'bajo_pedido' },
  ];
  fixture['products/p2/variants'] = [{ id: 'zero', active: true, price: 0 }];
  const app = runtime({ firestore: fixture });
  const products = await app.load(SERVICE).loadGiveawayProducts();
  const product = products.find((item) => item.productId === 'p1');
  assert.equal(product.productPrice, 45000);
  assert.equal(product.variantId, 'minimum');
  assert.equal(products.some((item) => item.productId === 'p2'), false);
  const html = runtime({ catalog: { products } }).render();
  contains(html, `${choices[0].productName} — ₡45 000`);
  assert.ok(!plain(html).includes(choices[1].productName));
});

test('fallo de una consulta de variantes falla cerrado sin reemplazar precio por base', async () => {
  const app = runtime({ firestore: catalogFixture(), readError: (path) => path === 'products/p1/variants' });
  await assert.rejects(app.load(SERVICE).loadGiveawayProducts(), /Firestore unavailable/);
});

test('búsqueda ignora tildes y mayúsculas, conserva selección visible y no vuelve a consultar Firestore', () => {
  const app = runtime({ search: 'rAsAsÍ', form: validForm });
  const html = app.render();
  contains(html, choices[1].productName);
  contains(html, `Colonia escogida: ${choices[0].productName}`);
  assert.equal(app.reads.length, 0);
  const searchInput = app.inputs.find((input) => input.id === 'giveaway-search');
  searchInput.onChange({ target: { value: 'Versace Eros' } });
  assert.equal(app.updates.at(-1), 'Versace Eros');
  assert.equal(app.reads.length, 0);
  assert.deepEqual(app.load(SERVICE).searchGiveawayProducts(choices, 'EROS vÉrsace'), [choices[0]]);
  assert.deepEqual(app.load(SERVICE).searchGiveawayProducts(choices, 'no existe'), []);
  const noMatches = runtime({ search: 'No existe' }).render();
  contains(noMatches, 'No hay coincidencias con esa búsqueda.');
});

test('selector entrega únicamente productId y explica una opción que desapareció al enviar', async () => {
  const app = runtime();
  app.render();
  app.selects[0].onChange({ target: { value: 'p2' } });
  assert.deepEqual(app.updates.at(-1)(validForm), { ...validForm, productId: 'p2' });
  const missing = runtime({ form: { ...validForm, productId: 'removed' }, call: forbidden('removed product') });
  contains(missing.render(), 'La colonia elegida ya no está en la lista. Escogé otra antes de participar.');
  assert.equal(findButton(missing, 'Participar en el sorteo').disabled, false);
  await missing.forms[0].onSubmit({ preventDefault() {} });
  assert.equal(missing.calls.length, 0);
  assert.ok(missing.updates.some((value) => value?.productId === 'Escogé una colonia de la lista para participar.'));
});

test('carga, error y catálogo vacío impiden inscripción y permiten reintentar', async () => {
  for (const override of [{ loading: true }, { error: true }, { products: [] }]) {
    let retried = 0;
    const app = runtime({ form: validForm, catalog: { ...override, retry: () => { retried++; } }, call: forbidden('catalog unavailable') });
    const html = app.render();
    assert.equal(findButton(app, 'Participar en el sorteo').disabled, true);
    assert.doesNotMatch(html, /<select/);
    await app.forms[0].onSubmit({ preventDefault() {} });
    assert.equal(app.calls.length, 0);
    if (!override.loading) {
      findButton(app, override.error ? 'Reintentar carga' : 'Actualizar colonias').onClick();
      assert.equal(retried, 1);
    }
  }
});

test('hook del catálogo carga una vez, expone resultados, limpia respuestas tardías y falla cerrado', async () => {
  for (const fail of [false, true]) {
    const effects = [];
    const states = [];
    const app = runtime({ realHooks: true, firestore: catalogFixture(),
      readError: () => fail,
      hookReact: { useState: (initial) => [initial, (next) => states.push(next)], useEffect: (effect) => effects.push(effect) },
    });
    const initial = app.load(HOOK).useGiveawayProducts();
    assert.equal(initial.loading, true);
    assert.deepEqual(initial.products, []);
    const cleanup = effects[0]();
    await new Promise(setImmediate);
    assert.equal(states.at(-1).loading, false);
    assert.equal(states.at(-1).error, fail);
    assert.equal(states.at(-1).products.length, fail ? 0 : 3);
    cleanup();
    initial.retry();
    assert.deepEqual(states.at(-2), { products: [], loading: true, error: false });
    assert.equal(states.at(-1)(3), 4);
  }
  const effects = [];
  const states = [];
  const unmounted = runtime({ realHooks: true, firestore: catalogFixture(),
    hookReact: { useState: (initial) => [initial, (next) => states.push(next)], useEffect: (effect) => effects.push(effect) },
  });
  unmounted.load(HOOK).useGiveawayProducts();
  effects[0]()();
  await new Promise(setImmediate);
  assert.deepEqual(states, []);
});

test('confirmación anuncia número e instrucción Instagram y conserva el snapshot del premio', () => {
  const html = runtime({ registration: { entry: receipt } }).render();
  const text = plain(html).replace(/\s+\./g, '.');
  assert.ok(text.includes('Tu número de participante es #12. Comentá ese número en la publicación del sorteo en Instagram @aqui.paulina'));
  contains(html, receipt.productName);
  contains(html, '₡47 000');
  assert.match(html, /href="https:\/\/www.instagram.com\/aqui.paulina\/"/);
});

test('inscripciones anteriores mantienen número y premio en confirmación y admin sin fabricar precio', () => {
  const legacy = { campaignId: config.campaignId, number: 2, prizeId: config.prizes[1].id, prizeLabel: config.prizes[1].label,
    createdAt: '2026-10-29T15:00:00.000Z' };
  const html = runtime({ registration: { entry: legacy } }).render();
  contains(html, 'Tu número de participante es #2');
  contains(html, config.prizes[1].label);
  assert.doesNotMatch(html, /data-testid="giveaway-form"/);
  const admin = runtime({ collection: { data: [{ ...legacy, id: 'legacy', fullName: 'Cliente anterior', phone: '88887777', email: 'before@example.invalid' }] } }).render(ADMIN);
  contains(admin, config.prizes[1].label);
  contains(admin, '#2');
  assert.match(admin, /<td[^>]*>—<\/td>/);
});
