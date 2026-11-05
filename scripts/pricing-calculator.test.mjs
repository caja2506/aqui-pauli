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

function renderView(exportName, props = {}, values = []) {
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
  return renderToStaticMarkup(React.createElement(module.exports[exportName], props));
}

const defaults = calculator.DEFAULT_PRICING_SETTINGS;
const product = { id: 'ls-0001', description: 'PERFUME PRUEBA 100ML', cashCRC: 10000, cardCRC: 11000, page: 1 };
test('la política solicitada inicia en 20%, 2900 nacional y 7000 internacional y migra v1', () => {
  assert.deepEqual(calculator.loadWorkbenchSettings(null), { version: 2, markupPercent: 20, roundingStep: 100, localShippingCRC: 2900, internationalShippingCRC: 7000 });
  assert.deepEqual(calculator.loadWorkbenchSettings(settings), defaults);
  assert.equal(calculator.loadWorkbenchSettings({ ...defaults, markupPercent: 25 }).markupPercent, 25);
  for (const key of ['localShippingCRC', 'internationalShippingCRC']) {
    assert.throws(() => calculator.validateWorkbenchSettings({ ...defaults, [key]: -1 }));
  }
});
test('búsqueda combina palabras sin tildes; conserva ambas columnas del proveedor', () => {
  assert.equal(calculator.filterSupplierProducts([product], 'perfúme 100ml').length, 1);
  assert.equal(calculator.filterSupplierProducts([product], 'perfume 50ml').length, 0);
  assert.equal(calculator.supplierPrice(product, 'cash'), 10000);
  assert.equal(calculator.supplierPrice(product, 'card'), 11000);
  assert.throws(() => calculator.supplierPrice(product, 'other'));
  const html = renderView('SupplierPricingDashboard', { catalog: { products: [product], sourceName: 'prueba.pdf' }, settings: defaults });
  assert.match(html, /PERFUME PRUEBA 100ML/);
  assert.match(html, /SINPE móvil o tarjeta/);
  assert.match(html, /10[\s\u00a0]000/);
  assert.match(html, /11[\s\u00a0]000/);
});
test('detalle abre con costo mayorista elegido, envío y ganancia; gráfico y precio copiable coinciden', () => {
  const html = renderView('PricingCalculator', { product });
  assert.match(html, /data-copy="15500"/);
  assert.match(html, /value="2900"/);
  assert.match(html, /value="20"/);
  assert.match(html, /Ganancia por unidad/);
  assert.match(html, /Distribución del precio/);
  assert.match(html, /2[\s\u00a0]600/);
  assert.match(renderView('PricingCalculator', { product, payment: 'card' }), /data-copy="16700"/);
});
test('compra internacional usa solo traslado de 7000 y no cotiza sin costo o tipo de cambio', () => {
  const empty = renderView('PricingCalculator', { mode: 'international' });
  assert.match(empty, /value="7000"/);
  assert.doesNotMatch(empty, /value="2900"|data-copy=/);
  const costs = { currency: 'USD', baseCost: 40, exchangeRate: 520, inboundShipping: 7000, delivery: 0, otherCosts: 0 };
  const html = renderView('PricingCalculator', { mode: 'international' }, [costs]);
  assert.match(html, /data-copy="33400"/);
  assert.match(html, /5[\s\u00a0]600/);
  assert.match(html, /Amazon: enlace y precio manual/);
  assert.doesNotMatch(renderView('PricingCalculator', { mode: 'international' }, [{ ...costs, exchangeRate: '' }]), /data-copy=/);
});

test('servicio guarda solo estándares privados validados y carga los valores solicitados', async () => {
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
    if (name === 'firebase/functions') return { httpsCallable: () => async () => ({ data: {} }) };
    if (name === '../firebase') return { db: {}, functions: {} };
    if (name.includes('pricingCalculator')) return calculator;
    throw Error(name);
  }, module, module.exports);
  const service = module.exports;
  assert.deepEqual(await service.getPricingSettings(), defaults);
  await service.savePricingSettings({ ...defaults, baseCost: 10000, productName: 'No guardar' });
  assert.deepEqual(stored, { ...defaults, updatedAt: 'SERVER_TIME' });
  assert.deepEqual(await service.getPricingSettings(), defaults);
  await assert.rejects(service.savePricingSettings({ ...defaults, markupPercent: -10 }));
  readError = new Error('permission-denied');
  await assert.rejects(service.getPricingSettings(), /permission-denied/);
  writeError = new Error('unavailable');
  await assert.rejects(service.savePricingSettings(defaults), /unavailable/);
});
