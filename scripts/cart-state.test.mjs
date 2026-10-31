import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import React from 'react';
import * as pilot from '../src/services/payments/tilopayPilot.js';
import { transformWithEsbuild } from 'vite';

const require = createRequire(import.meta.url);
const filename = 'src/contexts/CartContext.jsx';
const { code } = await transformWithEsbuild(await readFile(new URL(`../${filename}`, import.meta.url), 'utf8'), filename,
  { loader: 'jsx', jsx: 'automatic', format: 'cjs', target: 'es2022' });
const key = 'aquipauli_cart';
const line = { productId: 'zz-tilopay-test', variantId: 'v1', quantity: 1, price: 1000 };
function mount(initial = [line]) {
  const stored = new Map([[key, JSON.stringify(initial)]]);
  const listeners = new Map();
  const slots = []; let cursor = 0; let effects = []; let writes = 0;
  const slot = init => { const i = cursor++; return slots[i] ||= init(); };
  const react = { ...React,
    useCallback: fn => fn,
    useState(initial) {
      const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [state.value, update => { state.value = typeof update === 'function' ? update(state.value) : update; }];
    },
    useEffect(effect, deps) {
      const state = slot(() => ({}));
      if (!state.deps || deps.some((v, i) => !Object.is(v, state.deps[i]))) {
        state.deps = deps;
        effects.push(() => { state.cleanup?.(); state.cleanup = effect(); });
      }
    },
  };
  const localStorage = { getItem: name => stored.get(name) ?? null, setItem: (name, value) => { writes++; stored.set(name, value); } };
  const window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'localStorage', 'window', code)(
    name => name === 'react' ? react : name.endsWith('/tilopayPilot') ? pilot : require(name), module, module.exports, localStorage, window);
  const render = () => {
    cursor = 0; effects = [];
    const value = module.exports.CartProvider({ children: null }).props.value;
    effects.forEach(fn => fn());
    return value;
  };
  return { render, listeners, get writes() { return writes; },
    external(items, eventKey = key) {
      if (eventKey === null) stored.clear(); else stored.set(eventKey, JSON.stringify(items));
      listeners.get('storage')?.({ storageArea: localStorage, key: eventKey });
    },
    unmount() { slots.forEach(s => s.cleanup?.()); },
  };
}

test('contador y líneas del mismo carrito cambian juntos al agregar, editar y quitar', () => {
  const app = mount(); let cart = app.render();
  cart.addItem({ id: line.productId }, { id: line.variantId }, 2);
  cart = app.render();
  assert.equal(cart.items.length, 1); assert.equal(cart.items[0].quantity, 3);
  assert.equal(cart.itemCount, 3); assert.equal(cart.subtotal, 3000);
  cart.updateQuantity(line.productId, line.variantId, 1);
  cart = app.render(); assert.equal(cart.itemCount, 1); assert.equal(cart.subtotal, 1000);
  cart.clearCart(); cart = app.render();
  assert.equal(cart.items.length, 0); assert.equal(cart.itemCount, 0);
  app.unmount();
});

test('una pestaña abierta recibe carrito y cantidades de otra sin reescribir el evento', () => {
  const app = mount([{ ...line, quantity: 3 }]);
  assert.equal(app.render().itemCount, 3);
  app.external([line]);
  const current = app.render();
  assert.equal(current.itemCount, 1); assert.deepEqual(current.items, [line]);
  assert.equal(current.subtotal, 1000); assert.equal(app.writes, 0);
  app.external([], 'unrelated'); assert.equal(app.render().itemCount, 1);
  app.external([], null); assert.equal(app.render().itemCount, 0);
  app.unmount(); assert.equal(app.listeners.size, 0);
});
