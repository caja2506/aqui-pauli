// Exercise the real adapter and LoginPage handlers with local Firebase doubles.
// React renders the actual JSX; the hook harness preserves state, refs and effects
// between renders so pending requests and clicks before a rerender are testable.
// No Firebase app, network request, account lookup or real email is used here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithEsbuild } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const PAGE = 'src/components/auth/LoginPage.jsx';
const SERVICE = 'src/services/passwordReset.js';
const TITLE_HOOK = 'src/hooks/usePageTitle.js';
const files = [PAGE, SERVICE, TITLE_HOOK, 'src/components/auth/FacebookIcon.jsx'];
const compiled = new Map(await Promise.all(files.map(async (relative) => {
  const filename = path.join(root, relative);
  const result = await transformWithEsbuild(await readFile(filename, 'utf8'), filename, {
    loader: filename.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic',
    format: 'cjs', target: 'es2022', sourcemap: false,
  });
  return [filename, result.code];
})));
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const contains = (html, text) => assert.ok(plain(html).includes(text), `Missing text: ${text}`);
const elementText = (children) => plain(renderToStaticMarkup(React.createElement('span', null, children)));
const EMAIL = 'ana@example.invalid';
const PASSWORD = 'test-password-not-a-real-account';
const authError = (code, message = 'Private SDK error details') => Object.assign(new Error(message), { code });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function runtime(options = {}) {
  const abs = (relative) => path.join(root, relative);
  const cache = new Map();
  const forms = [];
  const inputs = [];
  const buttons = [];
  const sdkCalls = [];
  const authCalls = [];
  const navigations = [];
  const auth = { languageCode: 'en' };
  const location = { pathname: '/login', state: options.locationState || null };
  const hooks = [];
  let cursor = 0;
  let pendingEffects = [];
  const slot = (kind, initialize) => {
    const index = cursor++;
    if (!hooks[index]) hooks[index] = { kind, ...initialize() };
    assert.equal(hooks[index].kind, kind, `Hook order changed at slot ${index}`);
    return hooks[index];
  };
  const localReact = {
    ...React,
    useState(initial) {
      const state = slot('state', () => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [state.value, (next) => { state.value = typeof next === 'function' ? next(state.value) : next; }];
    },
    useRef(initial) {
      return slot('ref', () => ({ value: { current: initial } })).value;
    },
    useEffect(effect, dependencies) {
      const state = slot('effect', () => ({ initialized: false, dependencies: undefined, cleanup: undefined }));
      const changed = !state.initialized || !dependencies
        || dependencies.length !== state.dependencies?.length
        || dependencies.some((value, index) => !Object.is(value, state.dependencies[index]));
      if (changed) {
        state.initialized = true;
        state.dependencies = dependencies;
        pendingEffects.push(() => { state.cleanup?.(); state.cleanup = effect(); });
      }
    },
  };
  const jsx = require('react/jsx-runtime');
  const observe = (fn) => (type, props, ...rest) => {
    if (type === 'form') forms.push(props);
    if (type === 'input') inputs.push(props);
    if (type === 'button') buttons.push(props);
    return fn(type, props, ...rest);
  };
  const jsxRuntime = { ...jsx, jsx: observe(jsx.jsx), jsxs: observe(jsx.jsxs) };
  const operation = (name) => async (...args) => {
    authCalls.push({ name, args });
    return options[name]?.(...args);
  };
  const modules = new Map([
    [abs('src/firebase.js'), { auth }],
    [abs('src/contexts/AuthContext.js'), {
      useAuth: () => ({
        user: options.user || null, redirectError: options.redirectError || null,
        signInWithEmail: operation('signInWithEmail'), createAccount: operation('createAccount'),
        signInWithGoogle: operation('signInWithGoogle'), signInWithFacebook: operation('signInWithFacebook'),
      }),
      socialAuthErrorMessage: () => 'No pudimos completar el ingreso con Facebook. Intentá de nuevo.',
    }],
    [abs('src/hooks/useAuthFlags.js'), { useAuthFlags: () => ({ facebookEnabled: Boolean(options.facebookEnabled) }) }],
  ]);
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    assert.ok(compiled.has(filename), `Unexpected source import: ${path.relative(root, filename)}`);
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = (name) => {
      if (name === 'react') return [abs(PAGE), abs(TITLE_HOOK)].includes(filename) ? localReact : React;
      if (name === 'react/jsx-runtime') return jsxRuntime;
      if (name === 'lucide-react') return require(name);
      if (name === 'react-router-dom') return {
        Link: ({ to, children, ...props }) => React.createElement('a', { ...props, href: to }, children),
        useLocation: () => location,
        useNavigate: () => (...args) => navigations.push(args),
      };
      if (name === 'firebase/auth') return {
        sendPasswordResetEmail: (...args) => {
          sdkCalls.push({ args, languageCode: auth.languageCode });
          return options.sendPasswordResetEmail ? options.sendPasswordResetEmail(...args) : Promise.resolve();
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
  function render() {
    forms.length = inputs.length = buttons.length = 0;
    cursor = 0;
    pendingEffects = [];
    const Component = load(abs(PAGE)).default;
    const html = renderToStaticMarkup(Component());
    for (const effect of pendingEffects) effect();
    return html;
  }
  function button(label) {
    const match = buttons.find((props) => elementText(props.children) === label);
    assert.ok(match, `Missing button: ${label}`);
    return match;
  }
  function input(type) {
    const match = inputs.find((props) => props.type === type);
    assert.ok(match, `Missing input type: ${type}`);
    return match;
  }
  function enter(type, value) {
    const target = { value };
    input(type).onChange({ target, currentTarget: target });
    return render();
  }
  function openReset(email = EMAIL) {
    render();
    enter('email', email);
    button('¿Olvidaste tu contraseña?').onClick();
    return render();
  }
  function submit() {
    assert.equal(forms.length, 1);
    let prevented = false;
    const pending = forms[0].onSubmit({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    return pending;
  }
  return { render, button, input, enter, openReset, submit, forms, inputs, buttons, sdkCalls,
    authCalls, navigations, auth, service: () => load(abs(SERVICE)),
    unmount: () => { hooks.forEach((hook) => hook.cleanup?.()); } };
}

test('login, registro y recuperación actualizan el título y permiten volver a la tienda', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { title: 'Catálogo | Aquí Pauli' };
  try {
    const app = runtime();
    const checkStoreLink = (html) => {
      assert.match(html, /<a\b[^>]*href="\/"[^>]*>[\s\S]*?Volver a la tienda[\s\S]*?<\/a>/);
      contains(html, `© ${new Date().getFullYear()} Aquí Pauli`);
    };
    checkStoreLink(app.render());
    assert.equal(document.title, 'Iniciar sesión | Aquí Pauli');
    app.button('Crear Cuenta').onClick();
    checkStoreLink(app.render());
    assert.equal(document.title, 'Crear cuenta | Aquí Pauli');
    app.button('Iniciar Sesión').onClick();
    app.render();
    checkStoreLink(app.openReset());
    assert.equal(document.title, 'Restablecer contraseña | Aquí Pauli');
    app.unmount();
    assert.equal(document.title, 'Catálogo | Aquí Pauli');
    assert.deepEqual(app.sdkCalls, []);
    assert.deepEqual(app.authCalls, []);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  }
});

test('SDK: normaliza espacios, usa español y entrega el enlace al handler de Firebase sin actionCodeSettings', async () => {
  const app = runtime();
  for (const email of [EMAIL, '  Ana+pedido@Example.Invalid \t', 'a.b+c@sub.example.invalid']) {
    await app.service().requestPasswordReset(email);
    const call = app.sdkCalls.at(-1);
    assert.equal(call.args.length, 2);
    assert.equal(call.args[0], app.auth);
    assert.equal(call.args[1], email.trim());
    assert.equal(call.languageCode, 'es');
  }
  assert.equal(app.sdkCalls.length, 3);
  assert.deepEqual(app.authCalls, []);
});

test('SDK: rechaza correos vacíos, mal formados o demasiado largos antes de llamar a Firebase', async () => {
  const app = runtime();
  const invalidEmails = [undefined, null, 123, {}, '', ' \t ', 'ana', 'ana@', '@example.invalid',
    'ana@example', 'ana@@example.invalid', 'ana @example.invalid', 'ana@exam ple.invalid',
    'ana\n@example.invalid', `${'a'.repeat(243)}@example.com`];
  for (const email of invalidEmails) {
    await assert.rejects(app.service().requestPasswordReset(email), { code: 'auth/invalid-email' });
  }
  assert.equal(app.sdkCalls.length, 0);
  assert.equal(app.auth.languageCode, 'en');
});

test('SDK: cuenta ausente o deshabilitada produce el mismo resultado neutro que un envío aceptado', async () => {
  const results = [];
  for (const code of [null, 'auth/user-not-found', 'auth/user-disabled']) {
    const app = runtime({ sendPasswordResetEmail: async () => { if (code) throw authError(code); } });
    results.push(await app.service().requestPasswordReset(EMAIL));
    assert.equal(app.sdkCalls.length, 1);
  }
  assert.deepEqual(results, [undefined, undefined, undefined]);
  const message = runtime().service().PASSWORD_RESET_SUCCESS;
  assert.match(message, /^Si existe una cuenta con ese correo,/);
  assert.match(message, /enlace.*restablecer tu contraseña/);
  assert.match(message, /spam/);
});

test('SDK: propaga errores operativos y los traduce sin revelar mensajes internos', async () => {
  const expected = new Map([
    ['auth/invalid-email', 'Ingresá un correo electrónico válido.'],
    ['auth/missing-email', 'Ingresá un correo electrónico válido.'],
    ['auth/too-many-requests', 'Se hicieron demasiados intentos. Esperá unos minutos e intentá de nuevo.'],
    ['auth/network-request-failed', 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.'],
    ['auth/internal-error', 'No pudimos enviar el enlace. Intentá de nuevo en unos minutos.'],
  ]);
  for (const [code, message] of expected) {
    const error = authError(code);
    const app = runtime({ sendPasswordResetEmail: async () => { throw error; } });
    await assert.rejects(app.service().requestPasswordReset(EMAIL), (received) => received === error);
    assert.equal(app.service().passwordResetErrorMessage(error), message);
    assert.doesNotMatch(message, /Private SDK error details/);
  }
  assert.equal(runtime().service().passwordResetErrorMessage(null), expected.get('auth/internal-error'));
});

test('login: muestra recuperación junto al formulario existente, sin iniciar operaciones al renderizar', () => {
  const app = runtime();
  const html = app.render();
  contains(html, '¿Olvidaste tu contraseña?');
  contains(html, 'Continuar con Google');
  assert.equal(app.button('¿Olvidaste tu contraseña?').type, 'button');
  assert.equal(app.input('password').autoComplete, 'current-password');
  assert.equal(app.input('email').autoComplete, 'username');
  assert.equal(app.forms.length, 1);
  assert.deepEqual(app.sdkCalls, []);
  assert.deepEqual(app.authCalls, []);
  assert.deepEqual(app.navigations, []);
});

test('reset: conserva el correo escrito y muestra únicamente correo, explicación y volver a login', () => {
  const app = runtime({ facebookEnabled: true });
  app.render();
  app.enter('email', EMAIL);
  app.enter('password', PASSWORD);
  app.button('¿Olvidaste tu contraseña?').onClick();
  const html = app.render();
  contains(html, 'Restablecer contraseña');
  contains(html, 'Enviar enlace de recuperación');
  contains(html, 'Volver a iniciar sesión');
  assert.deepEqual(app.inputs.map((input) => input.type), ['email']);
  assert.equal(app.input('email').value, EMAIL);
  assert.equal(app.input('email').required, true);
  assert.equal(app.input('email')['aria-label'], 'Correo electrónico');
  assert.equal(app.input('email').autoComplete, 'email');
  assert.equal(app.input('email').autoCapitalize, 'none');
  assert.equal(app.input('email').spellCheck, false);
  assert.doesNotMatch(html, /type="password"|Continuar con Google|Continuar con Facebook/);
  assert.equal(app.button('Volver a iniciar sesión').type, 'button');
  assert.deepEqual(app.sdkCalls, []);
});

test('reset: envía el correo normalizado, anuncia éxito accesible y no inicia sesión ni navega', async () => {
  const app = runtime({ locationState: { from: '/sorteo' } });
  app.openReset(`  ${EMAIL}  `);
  await app.submit();
  const html = app.render();
  contains(html, app.service().PASSWORD_RESET_SUCCESS);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.equal(app.forms[0]['aria-busy'], false);
  assert.equal(app.button('Enviar enlace de recuperación').disabled, false);
  assert.equal(app.sdkCalls.length, 1);
  assert.deepEqual(app.sdkCalls[0].args, [app.auth, EMAIL]);
  assert.deepEqual(app.authCalls, []);
  assert.deepEqual(app.navigations, []);
});

test('reset: el resultado visible no revela si la cuenta existe o está deshabilitada', async () => {
  const rendered = [];
  for (const code of [null, 'auth/user-not-found', 'auth/user-disabled']) {
    const app = runtime({ sendPasswordResetEmail: async () => { if (code) throw authError(code); } });
    app.openReset();
    await app.submit();
    rendered.push(app.render());
    assert.equal(app.sdkCalls.length, 1);
    assert.deepEqual(app.navigations, []);
  }
  assert.equal(rendered[0], rendered[1]);
  assert.equal(rendered[0], rendered[2]);
});

test('reset: doble submit antes del render envía una sola vez y bloquea pestañas, correo y regreso mientras espera', async () => {
  const waiting = deferred();
  const app = runtime({ sendPasswordResetEmail: () => waiting.promise });
  app.openReset();
  const oldForm = app.forms[0];
  const oldTabs = [app.button('Iniciar Sesión'), app.button('Crear Cuenta'), app.button('Volver a iniciar sesión')];
  const first = app.submit();
  await oldForm.onSubmit({ preventDefault() {} });
  for (const button of oldTabs) button.onClick();
  assert.equal(app.sdkCalls.length, 1);
  const html = app.render();
  contains(html, 'Restablecer contraseña');
  contains(html, 'Enviando enlace...');
  assert.equal(app.forms[0]['aria-busy'], true);
  for (const input of app.inputs) assert.equal(input.disabled, true);
  for (const button of app.buttons) assert.equal(button.disabled, true);
  await app.submit();
  assert.equal(app.sdkCalls.length, 1);
  assert.deepEqual(app.authCalls, []);
  waiting.resolve();
  await first;
  contains(app.render(), app.service().PASSWORD_RESET_SUCCESS);
  assert.equal(app.forms[0]['aria-busy'], false);
  assert.equal(app.input('email').disabled, false);
  assert.equal(app.button('Volver a iniciar sesión').disabled, false);
});

test('reset: correo inválido muestra un error claro sin envío ni estado de éxito', async () => {
  const app = runtime();
  app.openReset('no-es-un-correo');
  await app.submit();
  const html = app.render();
  contains(html, 'Ingresá un correo electrónico válido.');
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /role="status"/);
  assert.equal(app.forms[0]['aria-busy'], false);
  assert.equal(app.button('Enviar enlace de recuperación').disabled, false);
  assert.equal(app.sdkCalls.length, 0);
});

test('reset: un error de conexión permite reintentar el mismo correo y recuperarse sin navegar', async () => {
  let attempts = 0;
  const app = runtime({ sendPasswordResetEmail: async () => {
    if (++attempts === 1) throw authError('auth/network-request-failed');
  } });
  app.openReset();
  await app.submit();
  let html = app.render();
  contains(html, 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.');
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /role="status"|Private SDK error details/);
  assert.equal(app.button('Enviar enlace de recuperación').disabled, false);
  await app.submit();
  html = app.render();
  contains(html, app.service().PASSWORD_RESET_SUCCESS);
  assert.doesNotMatch(html, /role="alert"/);
  assert.equal(app.sdkCalls.length, 2);
  assert.deepEqual(app.authCalls, []);
  assert.deepEqual(app.navigations, []);
});

test('reset: límites y errores desconocidos no filtran el error del SDK ni dejan el formulario bloqueado', async () => {
  for (const code of ['auth/too-many-requests', 'auth/internal-error']) {
    const error = authError(code);
    const app = runtime({ sendPasswordResetEmail: async () => { throw error; } });
    app.openReset();
    await app.submit();
    const html = app.render();
    contains(html, app.service().passwordResetErrorMessage(error));
    assert.doesNotMatch(html, /Private SDK error details|role="status"/);
    assert.equal(app.forms[0]['aria-busy'], false);
    assert.equal(app.input('email').disabled, false);
    assert.equal(app.button('Volver a iniciar sesión').disabled, false);
  }
});

test('reset: cambiar correo o modo elimina errores y éxitos anteriores', async () => {
  const app = runtime();
  app.openReset('inválido');
  await app.submit();
  assert.match(app.render(), /role="alert"/);
  assert.doesNotMatch(app.enter('email', EMAIL), /role="alert"|role="status"/);
  await app.submit();
  assert.match(app.render(), /role="status"/);
  assert.doesNotMatch(app.enter('email', 'otra@example.invalid'), /role="alert"|role="status"/);
  await app.submit();
  assert.match(app.render(), /role="status"/);
  app.button('Crear Cuenta').onClick();
  assert.doesNotMatch(app.render(), /role="alert"|role="status"|Restablecer contraseña/);
  app.button('Iniciar Sesión').onClick();
  app.render();
  app.button('¿Olvidaste tu contraseña?').onClick();
  assert.doesNotMatch(app.render(), /role="alert"|role="status"/);
  app.enter('email', 'inválido');
  await app.submit();
  assert.match(app.render(), /role="alert"/);
  app.button('Volver a iniciar sesión').onClick();
  assert.doesNotMatch(app.render(), /role="alert"|role="status"/);
});

test('login: volver de recuperación conserva correo y destino del sorteo sin conservar la contraseña anterior', async () => {
  const app = runtime({ locationState: { from: '/sorteo' } });
  app.render();
  app.enter('email', EMAIL);
  app.enter('password', PASSWORD);
  app.button('¿Olvidaste tu contraseña?').onClick();
  app.render();
  await app.submit();
  app.render();
  app.button('Volver a iniciar sesión').onClick();
  app.render();
  assert.equal(app.input('email').value, EMAIL);
  assert.equal(app.input('password').value, '');
  app.enter('password', PASSWORD);
  await app.submit();
  assert.deepEqual(app.authCalls, [{ name: 'signInWithEmail', args: [EMAIL, PASSWORD] }]);
  assert.deepEqual(app.navigations, [['/sorteo', { replace: true }]]);
  assert.equal(app.sdkCalls.length, 1);
});

test('registro: entrada desde el sorteo conserva nombre, contraseña nueva y retorno después de crear la cuenta', async () => {
  const app = runtime({ locationState: { from: '/sorteo', mode: 'register' } });
  app.render();
  assert.deepEqual(app.inputs.map((input) => input.type), ['text', 'email', 'password']);
  assert.equal(app.input('password').autoComplete, 'new-password');
  app.enter('text', 'Ana Prueba');
  app.enter('email', EMAIL);
  app.enter('password', PASSWORD);
  await app.submit();
  assert.deepEqual(app.authCalls, [{ name: 'createAccount', args: [EMAIL, PASSWORD, 'Ana Prueba'] }]);
  assert.deepEqual(app.navigations, [['/sorteo', { replace: true }]]);
  assert.deepEqual(app.sdkCalls, []);
});

test('registro: cambiar de recuperación a crear cuenta no pierde el destino ni solicita otro enlace', async () => {
  const app = runtime({ locationState: { from: '/sorteo' } });
  app.openReset();
  app.button('Crear Cuenta').onClick();
  app.render();
  assert.equal(app.input('email').value, EMAIL);
  app.enter('text', 'Ana Prueba');
  app.enter('password', PASSWORD);
  await app.submit();
  assert.deepEqual(app.authCalls, [{ name: 'createAccount', args: [EMAIL, PASSWORD, 'Ana Prueba'] }]);
  assert.deepEqual(app.navigations, [['/sorteo', { replace: true }]]);
  assert.deepEqual(app.sdkCalls, []);
});

test('Google: sigue disponible al volver de recuperación y conserva el destino original', async () => {
  for (const locationState of [null, { from: '/sorteo' }]) {
    const app = runtime({ locationState });
    app.openReset();
    app.button('Volver a iniciar sesión').onClick();
    app.render();
    await app.button('Continuar con Google').onClick();
    assert.deepEqual(app.authCalls, [{ name: 'signInWithGoogle', args: [] }]);
    assert.deepEqual(app.navigations, [[locationState?.from || '/', { replace: true }]]);
    assert.deepEqual(app.sdkCalls, []);
  }
});

test('Facebook: respeta su flag y conserva la navegación después de volver de recuperación', async () => {
  assert.doesNotMatch(runtime().render(), /Continuar con Facebook/);
  const app = runtime({ facebookEnabled: true, locationState: { from: '/sorteo' } });
  app.openReset();
  app.button('Volver a iniciar sesión').onClick();
  app.render();
  await app.button('Continuar con Facebook').onClick();
  assert.deepEqual(app.authCalls, [{ name: 'signInWithFacebook', args: [] }]);
  assert.deepEqual(app.navigations, [['/sorteo', { replace: true }]]);
  assert.deepEqual(app.sdkCalls, []);
});

test('login y registro: errores existentes siguen visibles y la edición de correo permite corregirlos', async () => {
  for (const [mode, operation, code, message] of [
    ['login', 'signInWithEmail', 'auth/invalid-credential', 'Credenciales inválidas'],
    ['register', 'createAccount', 'auth/email-already-in-use', 'Este correo ya está registrado'],
  ]) {
    const app = runtime({ locationState: { from: '/sorteo', mode }, [operation]: async () => { throw authError(code); } });
    app.render();
    app.enter('email', EMAIL);
    app.enter('password', PASSWORD);
    if (mode === 'register') app.enter('text', 'Ana Prueba');
    await app.submit();
    const html = app.render();
    contains(html, message);
    assert.match(html, /role="alert"/);
    assert.equal(app.forms[0]['aria-busy'], false);
    assert.deepEqual(app.navigations, []);
    assert.deepEqual(app.sdkCalls, []);
    assert.doesNotMatch(app.enter('email', 'otra@example.invalid'), /role="alert"/);
  }
});

test('auth: errores de redirect no contaminan recuperación y solo usuarios identificados redirigen al destino', () => {
  const app = runtime({ redirectError: 'Error anterior de Facebook' });
  contains(app.render(), 'Error anterior de Facebook');
  assert.doesNotMatch(app.openReset(), /Error anterior de Facebook|role="alert"/);
  for (const user of [null, { uid: 'guest', isAnonymous: true }, { uid: 'identified', isAnonymous: false }]) {
    const session = runtime({ user, locationState: { from: '/sorteo' } });
    session.render();
    session.render();
    assert.deepEqual(session.navigations, user && !user.isAnonymous ? [['/sorteo', { replace: true }]] : []);
    assert.deepEqual(session.sdkCalls, []);
  }
});
