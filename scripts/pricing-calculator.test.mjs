import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithEsbuild } from 'vite';
import * as calculator from '../src/utils/pricingCalculator.js';
import * as formatters from '../src/utils/formatters.js';

const settings = { markupPercent: 30, roundingStep: 100 };
const costs = { currency: 'CRC', baseCost: 10000, inboundShipping: 2000, delivery: 2500, otherCosts: 500 };

test('suma todos los costos y aplica ganancia sobre costo, no margen sobre venta', () => {
  const result = calculator.calculateSellingPrice(costs, settings);
  assert.equal(result.totalCost, 15000);
  assert.equal(result.suggestedPrice, 19500);
  assert.equal(result.profit, 4500);
  assert.ok(Math.abs(result.marginPercent - 23.076923) < 0.00001);
});
test('convierte solo la compra USD y conserva los demás gastos en colones', () => {
  const result = calculator.calculateSellingPrice({ ...costs, currency: 'USD', baseCost: 40, exchangeRate: 520 }, settings);
  assert.equal(result.purchaseCRC, 20800);
  assert.equal(result.totalCost, 25800);
  assert.equal(result.unroundedPrice, 33540);
  assert.equal(result.suggestedPrice, 33600);
  assert.equal(result.profit, 7800);
});
test('redondea hacia arriba sin sumar un bloque cuando el precio ya es exacto', () => {
  for (const step of calculator.PRICE_ROUNDING_STEPS) {
    const result = calculator.calculateSellingPrice({ currency: 'CRC', baseCost: 10000 }, { markupPercent: 30, roundingStep: step });
    assert.equal(result.suggestedPrice, 13000);
  }
  assert.equal(calculator.calculateSellingPrice({ currency: 'CRC', baseCost: 10001 }, { ...settings, roundingStep: 500 }).suggestedPrice, 13500);
  assert.equal(calculator.calculateSellingPrice({ currency: 'CRC', baseCost: 100.10 }, { markupPercent: 0, roundingStep: 1 }).suggestedPrice, 101);
  assert.equal(calculator.calculateSellingPrice({ currency: 'CRC', baseCost: 1.10 }, { markupPercent: 0, roundingStep: 1 }).totalCost, 1.10);
});
test('costos opcionales vacíos son cero; el costo base y la ganancia requieren valores explícitos', () => {
  const result = calculator.calculateSellingPrice({ currency: 'CRC', baseCost: '10000', inboundShipping: '', delivery: '', otherCosts: '' }, { markupPercent: '0', roundingStep: '100' });
  assert.equal(result.suggestedPrice, 10000);
  assert.equal(result.profit, 0);
  for (const value of ['', null, undefined, NaN, Infinity, -1, ' ', true, 'abc', 1001]) {
    assert.throws(() => calculator.validatePricingSettings({ ...settings, markupPercent: value }));
  }
  for (const value of ['', null, NaN, Infinity, -1, 0, 'abc']) {
    assert.throws(() => calculator.calculateSellingPrice({ ...costs, baseCost: value }, settings));
  }
});
test('rechaza tipos de cambio, redondeos y gastos inválidos sin mostrar precios engañosos', () => {
  for (const value of ['', null, ' ', 0, -520, Infinity]) {
    assert.throws(() => calculator.calculateSellingPrice({ ...costs, currency: 'USD', exchangeRate: value }, settings));
  }
  for (const key of ['inboundShipping', 'delivery', 'otherCosts']) {
    assert.throws(() => calculator.calculateSellingPrice({ ...costs, [key]: -1 }, settings));
  }
  assert.throws(() => calculator.calculateSellingPrice({ ...costs, currency: 'EUR' }, settings));
  assert.throws(() => calculator.calculateSellingPrice(costs, { ...settings, roundingStep: 0 }));
  assert.throws(() => calculator.calculateSellingPrice({ ...costs, baseCost: 1e9 }, settings));
});

const require = createRequire(import.meta.url);
const file = 'src/pages/admin/PricingPage.jsx';
const compiled = await transformWithEsbuild(await readFile(new URL('../' + file, import.meta.url), 'utf8'), file,
  { loader: 'jsx', jsx: 'automatic', format: 'cjs', target: 'es2022' });

function renderCalculator(values) {
  let index = 0;
  const module = { exports: {} };
  function load(name) {
    if (name === 'react') return { ...React, useState(initial) { const slot = index++; return [slot < values.length ? values[slot] : typeof initial === 'function' ? initial() : initial, () => {}]; } };
    if (name === 'react/jsx-runtime' || name === 'lucide-react') return require(name);
    if (name.includes('pricingCalculatorService')) return {};
    if (name.includes('pricingCalculator')) return calculator;
    if (name.includes('formatters')) return formatters;
    if (name.includes('usePageTitle')) return { __esModule: true, default() {} };
    if (name.includes('CopyButton')) return { __esModule: true, default: ({ text }) => React.createElement('button', { 'data-copy': text }, 'Copiar precio') };
    throw Error('Unexpected import ' + name);
  }
  new Function('require', 'module', 'exports', compiled.code)(load, module, module.exports);
  return renderToStaticMarkup(React.createElement(module.exports.PricingCalculator, { initialSettings: null, onSaveSettings: async value => value }));
}

test('primera apertura pide elegir una ganancia, sin inventar un estándar', () => {
  const html = renderCalculator([]);
  assert.match(html, /Ingresá la ganancia estándar/);
  assert.match(html, /Definí tu porcentaje/);
  assert.doesNotMatch(html, /data-copy=/);
});
test('la vista muestra el desglose, precio copiable y estándar persistido', () => {
  const html = renderCalculator([costs, settings, settings]);
  assert.match(html, /data-copy="19500"/);
  assert.match(html, /Ganancia por unidad/);
  assert.match(html, /23,1%/);
  assert.match(html, /Estándar guardado/);
});
test('un error de guardado queda visible y los datos del cálculo se conservan', () => {
  const html = renderCalculator([costs, settings, null, false, { error: true, text: 'No se pudo guardar' }]);
  assert.match(html, /role="alert"/);
  assert.match(html, /No se pudo guardar/);
  assert.match(html, /data-copy="19500"/);
});

test('servicio guarda solo la configuración privada validada y la vuelve a cargar', async () => {
  const path = 'src/services/pricingCalculatorService.js';
  const source = await transformWithEsbuild(await readFile(new URL('../' + path, import.meta.url), 'utf8'), path, { format: 'cjs', target: 'es2022' });
  const module = { exports: {} };
  let stored;
  let readError = null;
  let writeError = null;
  const sdk = {
    doc: (_db, ...parts) => { assert.deepEqual(parts, ['admin_pricing', 'settings']); return parts.join('/'); },
    getDoc: async () => { if (readError) throw readError; return { exists: () => !!stored, data: () => stored }; },
    setDoc: async (_ref, data) => { if (writeError) throw writeError; stored = data; },
    serverTimestamp: () => 'SERVER_TIME',
  };
  new Function('require', 'module', 'exports', source.code)(name => {
    if (name === 'firebase/firestore') return sdk;
    if (name === '../firebase') return { db: {} };
    if (name.includes('pricingCalculator')) return calculator;
    throw Error(name);
  }, module, module.exports);
  const service = module.exports;
  assert.equal(await service.getPricingSettings(), null);
  await service.savePricingSettings({ ...settings, baseCost: 10000, productName: 'No guardar' });
  assert.deepEqual(stored, { ...settings, updatedAt: 'SERVER_TIME' });
  assert.deepEqual(await service.getPricingSettings(), settings);
  await assert.rejects(service.savePricingSettings({ ...settings, markupPercent: -10 }));
  readError = new Error('permission-denied');
  await assert.rejects(service.getPricingSettings(), /permission-denied/);
  writeError = new Error('unavailable');
  await assert.rejects(service.savePricingSettings(settings), /unavailable/);
});
