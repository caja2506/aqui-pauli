// Exercise the real AuthContext and public flag hook with local SDK doubles.
// No Firebase initialization, OAuth redirect, real account or network request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { transformWithEsbuild } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const CONTEXT = 'src/contexts/AuthContext.jsx';
const FLAGS = 'src/hooks/useAuthFlags.js';
const compiled = new Map(await Promise.all([CONTEXT, FLAGS].map(async (relative) => {
  const filename = path.join(root, relative);
  const { code } = await transformWithEsbuild(await readFile(filename, 'utf8'), filename, {
    loader: filename.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic',
    format: 'cjs', target: 'es2022', sourcemap: false,
  });
  return [relative, code];
})));
const PRIVATE = 'test-only-oauth-token-do-not-log';
const sdkError = (code, credential) => Object.assign(new Error(PRIVATE), {
  code, customData: { _tokenResponse: { oauthAccessToken: PRIVATE } }, fbCredential: credential,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function hookHarness() {
  const hooks = [];
  let cursor = 0;
  let effects = [];
  const slot = (kind, initialize) => {
    const index = cursor++;
    if (!hooks[index]) hooks[index] = { kind, ...initialize() };
    assert.equal(hooks[index].kind, kind, `Hook order changed at ${index}`);
    return hooks[index];
  };
  const react = {
    ...React,
    useState(initial) {
      const state = slot('state', () => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [state.value, (next) => { state.value = typeof next === 'function' ? next(state.value) : next; }];
    },
    useReducer(reducer, initial) {
      const state = slot('reducer', () => ({ value: initial }));
      return [state.value, (action) => { state.value = reducer(state.value, action); }];
    },
    useEffect(effect, dependencies) {
      const state = slot('effect', () => ({ initialized: false, dependencies: undefined }));
      const changed = !state.initialized || !dependencies
        || dependencies.length !== state.dependencies?.length
        || dependencies.some((value, index) => !Object.is(value, state.dependencies[index]));
      if (changed) {
        state.initialized = true;
        state.dependencies = dependencies;
        effects.push(() => { state.cleanup?.(); state.cleanup = effect(); });
      }
    },
  };
  return {
    react,
    render(fn) {
      cursor = 0;
      effects = [];
      const result = fn();
      effects.forEach((effect) => effect());
      return result;
    },
    unmount() {
      hooks.forEach((hook) => hook.cleanup?.());
      hooks.length = 0;
      cursor = 0;
      effects = [];
    },
  };
}

function authRuntime(options = {}) {
  const hooks = hookHarness();
  const calls = [];
  const logs = [];
  const auth = { currentUser: options.user || null };
  const facebookProvider = { providerId: 'facebook.com' };
  const googleProvider = { providerId: 'google.com' };
  let listener;
  const publishUser = (user) => { auth.currentUser = user; listener?.(user); return { user }; };
  const defaults = {
    async signInWithPopup(_auth, provider) {
      return publishUser({ uid: 'identified-user', isAnonymous: false, providerData: [{ providerId: provider.providerId }] });
    },
    async linkWithPopup(user) {
      // Firebase can mutate this object in place without publishing a new identity.
      user.isAnonymous = false;
      return { user };
    },
    async signInWithCredential() { return publishUser({ uid: 'existing-facebook-user', isAnonymous: false }); },
    async getRedirectResult() { return null; },
  };
  const invoke = (name) => (...args) => {
    calls.push({ name, args });
    if (options[name]) return options[name](...args);
    if (defaults[name]) return defaults[name](...args);
    throw new Error(`Unexpected SDK operation: ${name}`);
  };
  const sdk = Object.fromEntries([
    'signInWithPopup', 'linkWithPopup', 'signInWithCredential', 'getRedirectResult',
    'signInWithRedirect', 'linkWithRedirect', 'signInAnonymously',
    'signInWithEmailAndPassword', 'createUserWithEmailAndPassword', 'updateProfile', 'signOut',
    'fetchSignInMethodsForEmail', 'linkWithCredential',
  ].map((name) => [name, invoke(name)]));
  sdk.onAuthStateChanged = (target, callback) => {
    assert.equal(target, auth);
    calls.push({ name: 'onAuthStateChanged', args: [target] });
    listener = callback;
    callback(auth.currentUser);
    return () => { listener = undefined; };
  };
  sdk.FacebookAuthProvider = {
    credentialFromError(error) {
      calls.push({ name: 'facebookCredentialFromError', args: [error] });
      return error.fbCredential || null;
    },
  };
  sdk.GoogleAuthProvider = {
    credentialFromError(error) {
      calls.push({ name: 'googleCredentialFromError', args: [error] });
      return error.googleCredential || null;
    },
  };
  const logger = Object.fromEntries(['error', 'warn', 'log', 'info', 'debug'].map((level) =>
    [level, (...args) => logs.push({ level, args })]));
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === 'react') return hooks.react;
    if (name === 'react/jsx-runtime') return require(name);
    if (name === 'firebase/auth') return sdk;
    if (name === '../firebase') return { auth, facebookProvider, googleProvider };
    throw new Error(`Unexpected import: ${name}`);
  };
  new Function('require', 'module', 'exports', 'console', 'navigator', compiled.get(CONTEXT))(
    localRequire, module, module.exports, logger, { userAgent: options.userAgent || 'Desktop test browser' },
  );
  const render = () => hooks.render(() => module.exports.AuthProvider({ children: null }).props.value);
  const operationNames = () => calls.filter(({ name }) => !['getRedirectResult', 'onAuthStateChanged'].includes(name)).map(({ name }) => name);
  render();
  return { render, calls, logs, auth, facebookProvider, googleProvider, operationNames,
    module: module.exports, publishUser, unmount: hooks.unmount };
}

function assertPrivateErrorNotLogged(app, error) {
  assert.ok(app.logs.every(({ args }) => !args.includes(error)), 'Raw SDK error reached console');
  assert.doesNotMatch(JSON.stringify(app.logs), new RegExp(PRIVATE));
}

test('Facebook: sesión nueva usa popup en desktop, Android, iPhone y navegador integrado; nunca redirect', async () => {
  for (const userAgent of ['Desktop Chrome', 'Mozilla/5.0 Android Mobile', 'Mozilla/5.0 iPhone', 'FBAN/FBIOS FBAV/123 Instagram']) {
    const app = authRuntime({ userAgent });
    assert.deepEqual(app.operationNames(), []);
    assert.equal(app.render().loading, false);
    await app.render().signInWithFacebook();
    assert.deepEqual(app.operationNames(), ['signInWithPopup']);
    assert.deepEqual(app.calls.at(-1).args, [app.auth, app.facebookProvider]);
    assert.equal(app.render().user.uid, 'identified-user');
    assert.equal(app.render().isAnonymous, false);
    app.unmount();
  }
});

test('Facebook: una sesión identificada usa autenticación, no vincula proveedores por coincidencia de correo', async () => {
  const user = { uid: 'google-user', isAnonymous: false, email: 'test@example.invalid' };
  const app = authRuntime({ user });
  await app.render().signInWithFacebook();
  assert.deepEqual(app.operationNames(), ['signInWithPopup']);
  assert.equal(user.uid, 'google-user');
});

test('Facebook: vincular una sesión invitada conserva el UID y actualiza el contexto aunque User sea el mismo objeto', async () => {
  for (const userAgent of ['Desktop test browser', 'Android Mobile']) {
    const guest = { uid: 'guest-with-existing-orders', isAnonymous: true };
    const app = authRuntime({ user: guest, userAgent });
    assert.equal(app.render().isAnonymous, true);
    await app.render().signInWithFacebook();
    assert.deepEqual(app.operationNames(), ['linkWithPopup']);
    assert.deepEqual(app.calls.at(-1).args, [guest, app.facebookProvider]);
    assert.equal(app.auth.currentUser, guest);
    assert.equal(app.render().user.uid, 'guest-with-existing-orders');
    assert.equal(app.render().isAnonymous, false);
  }
});

test('Facebook: credencial ya utilizada inicia la cuenta existente sin transferir ni vincular pedidos por email', async () => {
  const guest = { uid: 'guest-with-existing-orders', isAnonymous: true };
  const credential = { providerId: 'facebook.com', accessToken: PRIVATE };
  const error = sdkError('auth/credential-already-in-use', credential);
  const app = authRuntime({ user: guest, linkWithPopup: async () => { throw error; } });
  await app.render().signInWithFacebook();
  assert.deepEqual(app.operationNames(), ['linkWithPopup', 'facebookCredentialFromError', 'signInWithCredential']);
  assert.deepEqual(app.calls.at(-1).args, [app.auth, credential]);
  assert.equal(app.render().user.uid, 'existing-facebook-user');
  assert.equal(guest.uid, 'guest-with-existing-orders');
  assert.equal(guest.isAnonymous, true);
  assertPrivateErrorNotLogged(app, error);
});

test('Facebook: credencial ausente conserva la sesión invitada y rechaza el error sin un login alternativo', async () => {
  const guest = { uid: 'guest', isAnonymous: true };
  const error = sdkError('auth/credential-already-in-use');
  const app = authRuntime({ user: guest, linkWithPopup: async () => { throw error; } });
  await assert.rejects(app.render().signInWithFacebook(), (received) => received === error);
  assert.deepEqual(app.operationNames(), ['linkWithPopup', 'facebookCredentialFromError']);
  assert.equal(app.auth.currentUser, guest);
  assert.equal(guest.isAnonymous, true);
  assertPrivateErrorNotLogged(app, error);
});

test('Facebook: conflicto con otro método o email no hace vinculación automática ni consume una credencial pendiente', async () => {
  for (const code of ['auth/account-exists-with-different-credential', 'auth/email-already-in-use']) {
    const guest = { uid: 'guest', isAnonymous: true };
    const error = sdkError(code, { providerId: 'facebook.com', accessToken: PRIVATE });
    const app = authRuntime({ user: guest, linkWithPopup: async () => { throw error; } });
    await assert.rejects(app.render().signInWithFacebook(), (received) => received === error);
    assert.deepEqual(app.operationNames(), ['linkWithPopup']);
    assert.equal(app.auth.currentUser, guest);
    assertPrivateErrorNotLogged(app, error);
  }
});

test('Facebook: cancelación, popup bloqueado, red y configuración rechazan sin filtrar el error ni reintentar otro flujo', async () => {
  for (const code of ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/popup-blocked',
    'auth/network-request-failed', 'auth/operation-not-allowed', 'auth/unauthorized-domain', 'auth/internal-error']) {
    const error = sdkError(code);
    const app = authRuntime({ signInWithPopup: async () => { throw error; } });
    await assert.rejects(app.render().signInWithFacebook(), (received) => received === error);
    assert.deepEqual(app.operationNames(), ['signInWithPopup']);
    assert.equal(app.auth.currentUser, null);
    assertPrivateErrorNotLogged(app, error);
  }
});

test('Facebook: si falla la credencial existente, se propaga ese error y no se abandona la sesión invitada', async () => {
  const guest = { uid: 'guest', isAnonymous: true };
  const firstError = sdkError('auth/credential-already-in-use', { providerId: 'facebook.com', accessToken: PRIVATE });
  const secondError = sdkError('auth/network-request-failed');
  const app = authRuntime({ user: guest,
    linkWithPopup: async () => { throw firstError; }, signInWithCredential: async () => { throw secondError; } });
  await assert.rejects(app.render().signInWithFacebook(), (received) => received === secondError);
  assert.deepEqual(app.operationNames(), ['linkWithPopup', 'facebookCredentialFromError', 'signInWithCredential']);
  assert.equal(app.auth.currentUser, guest);
  assertPrivateErrorNotLogged(app, firstError);
  assertPrivateErrorNotLogged(app, secondError);
});

test('Facebook: mensajes de error orientan al método previo, permisos de popup y conexión; nunca contienen datos del SDK', () => {
  const message = authRuntime().module.socialAuthErrorMessage;
  const conflict = message(sdkError('auth/account-exists-with-different-credential'), 'Facebook');
  assert.match(conflict, /otro método|método.*anterior/i);
  assert.match(conflict, /Google|contraseña/);
  const blocked = message(sdkError('auth/popup-blocked'), 'Facebook');
  assert.match(blocked, /ventana|popup/i);
  assert.match(blocked, /permit|Chrome|Safari/i);
  assert.match(message(sdkError('auth/network-request-failed'), 'Facebook'), /conexión|internet/i);
  for (const code of ['auth/account-exists-with-different-credential', 'auth/popup-blocked', 'auth/network-request-failed',
    'auth/operation-not-allowed', 'auth/unauthorized-domain', 'auth/internal-error']) {
    const rendered = message(sdkError(code), 'Facebook');
    assert.equal(typeof rendered, 'string');
    assert.ok(rendered.length > 10);
    assert.doesNotMatch(rendered, new RegExp(PRIVATE));
  }
});

test('Facebook: cerrar voluntariamente el popup no muestra un error', () => {
  const message = authRuntime().module.socialAuthErrorMessage;
  for (const code of ['auth/popup-closed-by-user', 'auth/cancelled-popup-request']) {
    assert.equal(message(sdkError(code), 'Facebook'), null);
  }
});

test('redirect anterior: sigue consumiendo el resultado pendiente y recupera una credencial existente sin exponer tokens', async () => {
  const credential = { providerId: 'facebook.com', accessToken: PRIVATE };
  const error = sdkError('auth/credential-already-in-use', credential);
  const app = authRuntime({ getRedirectResult: async () => { throw error; } });
  await settle();
  assert.deepEqual(app.operationNames(), ['facebookCredentialFromError', 'signInWithCredential']);
  assert.equal(app.render().user.uid, 'existing-facebook-user');
  assert.equal(app.render().redirectError, null);
  assertPrivateErrorNotLogged(app, error);
});

test('redirect anterior: errores se muestran traducidos sin registrar la respuesta OAuth completa', async () => {
  const error = sdkError('auth/account-exists-with-different-credential');
  const app = authRuntime({ getRedirectResult: async () => { throw error; } });
  await settle();
  assert.match(app.render().redirectError, /otro método|método.*anterior/i);
  assert.deepEqual(app.operationNames(), []);
  assertPrivateErrorNotLogged(app, error);
});

test('Google: conserva popup para login y vinculación del invitado al incorporar Facebook', async () => {
  for (const user of [null, { uid: 'google-guest', isAnonymous: true }]) {
    const app = authRuntime({ user });
    await app.render().signInWithGoogle();
    assert.deepEqual(app.operationNames(), [user ? 'linkWithPopup' : 'signInWithPopup']);
    assert.equal(app.calls.at(-1).args[1], app.googleProvider);
    assert.equal(app.render().isAnonymous, false);
    if (user) assert.equal(app.render().user.uid, 'google-guest');
  }
});

function flagRuntime({ exists = true, data = {}, read } = {}) {
  const hooks = hookHarness();
  const calls = [];
  const db = {};
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === 'react') return hooks.react;
    if (name === '../firebase') return { db };
    if (name === 'firebase/firestore') return {
      doc(target, ...segments) { assert.equal(target, db); return { path: segments.join('/') }; },
      getDoc(ref) { calls.push(ref.path); return read ? read() : Promise.resolve({ exists: () => exists, data: () => data }); },
    };
    throw new Error(`Unexpected import: ${name}`);
  };
  new Function('require', 'module', 'exports', compiled.get(FLAGS))(localRequire, module, module.exports);
  return { render: () => hooks.render(() => module.exports.useAuthFlags()), calls, unmount: hooks.unmount };
}

test('flag Facebook: queda oculto mientras se verifica config/auth, sin escritura de configuración', async () => {
  const pending = deferred();
  const app = flagRuntime({ read: () => pending.promise });
  assert.equal(app.render().facebookEnabled, false);
  assert.equal(app.render().facebookEnabled, false);
  assert.deepEqual(app.calls, ['config/auth']);
  pending.resolve({ exists: () => false });
  await settle();
  assert.equal(app.render().facebookEnabled, true);
});

test('flag Facebook: proveedor habilitado por defecto si falta el documento o no hay false booleano explícito', async () => {
  for (const options of [{ exists: false }, { data: {} }, { data: { facebookEnabled: true } },
    { data: { facebookEnabled: null } }, { data: { facebookEnabled: 'false' } }]) {
    const app = flagRuntime(options);
    app.render();
    await settle();
    assert.equal(app.render().facebookEnabled, true);
    assert.deepEqual(app.calls, ['config/auth']);
  }
});

test('flag Facebook: false explícito mantiene oculto el botón', async () => {
  const app = flagRuntime({ data: { facebookEnabled: false } });
  app.render();
  await settle();
  assert.equal(app.render().facebookEnabled, false);
});

test('flag Facebook: lectura fallida queda cerrada y no habilita el proveedor por error', async () => {
  const app = flagRuntime({ read: async () => { throw new Error('permission-denied'); } });
  assert.equal(app.render().facebookEnabled, false);
  await settle();
  assert.equal(app.render().facebookEnabled, false);
  assert.deepEqual(app.calls, ['config/auth']);
});

test('flag Facebook: un fallo transitorio no queda cacheado y al remontar permite recuperar la configuración', async () => {
  let attempts = 0;
  const app = flagRuntime({ read: async () => {
    if (++attempts === 1) throw new Error('offline');
    return { exists: () => false };
  } });
  app.render();
  await settle();
  assert.equal(app.render().facebookEnabled, false);
  app.unmount();
  assert.equal(app.render().facebookEnabled, false);
  await settle();
  assert.equal(app.render().facebookEnabled, true);
  assert.deepEqual(app.calls, ['config/auth', 'config/auth']);
});
