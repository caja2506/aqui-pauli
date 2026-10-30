// Unit/render regressions with local cart spies. No remote writes or real orders.
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
import { getVariantPrice, getProductPriceSummary } from '../src/utils/productPrice.js';
import { formatCRC } from '../src/utils/formatters.js';
import { selectGiveawayProduct } from '../functions/lib/giveawayCatalog.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { parseMinorCRC, minorToCRC } = require('../functions/lib/paymentMoney.js');
const { computeTotalsCRC } = require('../functions/lib/pricing.js');
const CARD = 'src/components/storefront/ProductCard.jsx';
const PAGE = 'src/pages/store/ProductPage.jsx';
const abs = name => path.join(root, name);
const product = { id: 'tenis', name: 'Tenis de prueba', basePrice: 138500, images: [] };
const variant = (id, price, extra = {}) => ({ id, name: id, price,
  active: true, commercialStatus: 'disponible', supplyType: 'stock_propio', ...extra });
const options = [variant('Negro 35', 100000), variant('Rojo 34', 119000)];
const compiled = new Map(await Promise.all([
  CARD, PAGE, 'src/utils/productPrice.js', 'functions/lib/catalogPrice.mjs', 'src/utils/constants.js',
  'src/utils/formatters.js', 'src/utils/backorder.js', 'src/utils/shippingText.js',
  'src/components/ui/StatusBadge.jsx', 'src/components/ui/LoadingSpinner.jsx',
].map(async relative => {
  const filename = abs(relative);
  const result = await transformWithEsbuild(await readFile(filename, 'utf8'), filename,
    { loader: filename.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic', format: 'cjs', target: 'es2022' });
  return [filename, result.code];
})));

const forbidden = name => () => { throw new Error(`External operation forbidden: ${name}`); };
const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const money = amount => plain(formatCRC(amount));
const childrenText = node => typeof node === 'string' ? node
  : Array.isArray(node) ? node.map(childrenText).join('') : childrenText(node?.props?.children || '');
function render(relative, { item = product, variants = options, selected = null, quantity = 1, loading = false, error = false } = {}) {
  const states = relative === CARD ? [variants, loading, error]
    : [item, variants, selected, quantity, loading, false, 0, error];
  let slot = 0;
  const titles = [];
  const cartAdds = [];
  const buttons = [];
  const componentReact = { ...React, useState(initial) { return React.useState(slot < states.length ? states[slot++] : initial); } };
  const jsx = require('react/jsx-runtime');
  const jsxSpies = { ...jsx, ...Object.fromEntries(['jsx', 'jsxs'].map(key => [key, (type, props, ...rest) => {
    if (type === 'button' && props?.onClick) buttons.push(props);
    return jsx[key](type, props, ...rest);
  }])) };
  const mocks = new Map([
    [abs('src/firebase.js'), { db: {} }],
    [abs('src/contexts/CartContext.js'), { useCart: () => ({ addItem: (...args) => cartAdds.push(args) }) }],
    [abs('src/hooks/usePageTitle.js'), { __esModule: true, default: title => titles.push(title) }],
  ]);
  const cache = new Map();
  function load(filename) {
    if (mocks.has(filename)) return mocks.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const code = compiled.get(filename);
    assert.ok(code, `Unexpected source: ${filename}`);
    const module = { exports: {} }; cache.set(filename, module);
    const localRequire = name => {
      if (name === 'react') return filename === abs(relative) ? componentReact : React;
      if (name === 'react/jsx-runtime') return jsxSpies;
      if (['react-router-dom', 'lucide-react'].includes(name)) return require(name);
      if (name === 'firebase/firestore') return Object.fromEntries(
        ['doc', 'onSnapshot', 'collection', 'getDocs'].map(key => [key, forbidden(key)]));
      assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`);
      const target = path.resolve(path.dirname(filename), name);
      const resolved = (path.extname(target) ? [target] : [`${target}.js`, `${target}.jsx`])
        .find(candidate => mocks.has(candidate) || compiled.has(candidate));
      assert.ok(resolved, `Unresolved import ${name}`);
      return load(resolved);
    };
    new Function('require', 'module', 'exports', 'setTimeout', code)(localRequire, module, module.exports, () => 0);
    return module.exports;
  }
  const Component = load(abs(relative)).default;
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/producto/tenis'] },
    React.createElement(Routes, null, React.createElement(Route, { path: '/producto/:productId',
      element: React.createElement(Component, { product: item }) }))));
  return { html, text: plain(html), price: plain(html.match(/<div[^>]*data-testid="product-price"[^>]*>([\s\S]*?)<\/div>/)?.[1] || ''), titles, cartAdds,
    addToCart: buttons.find(button => childrenText(button.children).includes('Agregar al Carrito'))?.onClick };
}

test('mínimo de variantes reemplaza basePrice desactualizado y no depende del orden', () => {
  for (const variants of [options, [...options].reverse()]) {
    const summary = getProductPriceSummary(product, variants);
    assert.equal(summary.price, 100000);
    assert.equal(summary.isFrom, true);
    assert.equal(summary.mainVariant.id, 'Negro 35');
  }
});

test('selección Rojo 34 usa su precio exacto', () => {
  assert.equal(getVariantPrice(product, options[1]), 119000);
});

test('precios iguales y una sola variante no necesitan Desde', () => {
  for (const variants of [[options[0]], [options[0], variant('Blanco 36', 100000)]]) {
    assert.equal(getProductPriceSummary(product, variants).isFrom, false);
  }
});

test('Desde excluye opciones inactivas, eliminadas y de precio inválido', () => {
  const variants = [variant('inactive', 1, { active: false }), variant('deleted', 2, { deleted: true }),
    variant('invalid', 0),
    variant('backorder', 119000, { commercialStatus: 'Bajo Pedido', supplyType: 'bajo_pedido' })];
  assert.deepEqual(getProductPriceSummary(product, variants), {
    price: 119000, isFrom: false, mainVariant: variants.at(-1),
  });
});

test('sin variantes activas conserva precio base de referencia, sin habilitar compra', () => {
  assert.equal(getProductPriceSummary(product, []).price, 138500);
  assert.equal(render(CARD, { variants: [] }).price, money(138500));
  assert.equal(render(PAGE, { variants: [] }).price, money(138500));
  assert.ok(!render(CARD, { variants: [] }).text.includes('Ver opciones'));
  assert.ok(!render(PAGE, { variants: [] }).text.includes('Agregar al Carrito'));
});

test('precio ausente hereda basePrice pero cero explícito no', () => {
  for (const price of [undefined, null, '']) assert.equal(getVariantPrice(product, { price }), 138500);
  for (const price of [0, '0', false, -1, 'gratis', '1,000', '1e3', ' ', Infinity, NaN, {}, '10.001']) {
    assert.equal(getVariantPrice(product, { price }), null, `Rejected catalog value: ${String(price)}`);
  }
});

test('la validación monetaria de presentación coincide con la del servidor', () => {
  for (const raw of [1, '1', 0.01, '119000.50', ' 2500 ', 0, '', null, undefined, false,
    -5, '0.001', '1e4', '12,50', Infinity, '90071992547409.91', '90071992547409.90']) {
    let expected = null;
    try { expected = minorToCRC(parseMinorCRC(raw === null || raw === undefined || raw === '' ? product.basePrice : raw)); }
    catch { /* Invalid catalog amounts must not appear as purchasable prices. */ }
    assert.equal(getVariantPrice(product, { price: raw }), expected, `Parity for ${String(raw)}`);
  }
});

test('precio de venta de variante prevalece sobre precio base mayor o menor', () => {
  for (const basePrice of [50000, 200000]) {
    assert.equal(getProductPriceSummary({ ...product, basePrice }, [options[1]]).price, 119000);
  }
});

test('tarjeta no muestra basePrice ni cero mientras consulta las variantes', () => {
  const result = render(CARD, { variants: [], loading: true });
  assert.equal(result.price, 'Cargando precio…');
  assert.ok(!result.text.includes(money(product.basePrice)));
  assert.ok(!result.text.includes('Ver opciones'));
});

test('tarjeta y ficha sin selección muestran el mismo Desde para los tenis', () => {
  const card = render(CARD);
  const page = render(PAGE);
  assert.equal(card.price, `Desde ${money(100000)}`);
  assert.equal(page.price, card.price);
  assert.ok(!page.text.includes(money(138500)));
  assert.ok(!page.text.includes('Agregar al Carrito'));
  assert.ok(page.text.includes('Seleccioná una variante'));
});

test('la ficha seleccionada muestra ₡119000 sin Desde y permite agregar', () => {
  const page = render(PAGE, { selected: options[1] });
  assert.equal(page.price, money(119000));
  assert.ok(page.text.includes('Agregar al Carrito'));
  assert.deepEqual(page.titles, ['Tenis de prueba | Aquí Pauli']);
});

test('una única oferta muestra el precio exacto en tarjeta y ficha', () => {
  const variants = [options[1]];
  assert.equal(render(CARD, { variants }).price, money(119000));
  assert.equal(render(PAGE, { variants, selected: variants[0] }).price, money(119000));
});

test('precio público conserva variante agotada y la compra requiere una opción disponible', () => {
  const variants = [{ ...options[0], commercialStatus: 'agotado' }, options[1]];
  assert.equal(render(CARD, { variants }).price, `Desde ${money(100000)}`);
  assert.equal(render(PAGE, { variants }).price, `Desde ${money(100000)}`);
  assert.ok(render(CARD, { variants }).text.includes('Ver opciones'));
  const soldOut = render(PAGE, { variants, selected: variants[0] });
  assert.equal(soldOut.price, money(100000));
  assert.ok(!soldOut.addToCart);
  assert.match(soldOut.html, /<button[^>]*disabled=""[^>]*>Negro 35<\/button>/);
  assert.ok(!render(CARD, { variants: [variants[0]] }).text.includes('Ver opciones'));
});

test('variante con cero explícito no usa precio base ni habilita compra', () => {
  const variants = [variant('Cero', 0)];
  const card = render(CARD, { variants });
  const page = render(PAGE, { variants, selected: variants[0] });
  assert.equal(card.price, 'Sin opciones disponibles');
  assert.equal(page.price, 'Precio no disponible');
  assert.ok(!card.text.includes('Ver opciones'));
  assert.ok(!page.text.includes('Agregar al Carrito'));
  assert.match(page.html, /<button[^>]*disabled=""[^>]*>Cero<\/button>/);
});

test('variantes antiguas sin active se muestran igual en tarjeta y ficha', () => {
  const legacy = { id: 'legacy', name: 'Clásico', price: 110000 };
  assert.equal(render(CARD, { variants: [legacy] }).price, money(110000));
  assert.equal(render(PAGE, { variants: [legacy], selected: legacy }).price, money(110000));
});

test('error de consulta de variantes muestra indisponibilidad, no un precio inventado', () => {
  const card = render(CARD, { variants: [], error: true });
  const page = render(PAGE, { variants: [], error: true });
  assert.equal(card.price, 'Precio no disponible');
  assert.equal(page.price, 'Precio no disponible');
  assert.ok(page.text.includes('No pudimos cargar las tallas/opciones'));
  assert.ok(!card.text.includes(money(product.basePrice)));
  assert.ok(!page.text.includes(money(product.basePrice)));
});

test('Agregar al Carrito envía exactamente el precio de la variante seleccionada', async () => {
  for (const rawPrice of [119000, '119000', undefined]) {
    const selected = variant('rojo34', rawPrice);
    const page = render(PAGE, { variants: [selected], selected, quantity: 2 });
    assert.equal(typeof page.addToCart, 'function');
    page.addToCart();
    assert.equal(page.cartAdds.length, 1);
    const [cartProduct, cartVariant, quantity] = page.cartAdds[0];
    assert.equal(cartProduct.id, product.id);
    assert.equal(cartVariant.id, 'rojo34');
    assert.equal(quantity, 2);
    const records = { 'products/tenis': product, 'products/tenis/variants/rojo34': selected };
    const reference = key => ({
      get: async () => ({ exists: Boolean(records[key]), data: () => records[key] }),
      doc: id => reference(`${key}/${id}`), collection: name => reference(`${key}/${name}`),
    });
    const totals = await computeTotalsCRC({ collection: reference },
      [{ productId: 'tenis', variantId: 'rojo34', quantity }], {});
    assert.equal(cartVariant.price, totals.lines[0].unitPrice);
    assert.equal(typeof cartVariant.price, 'number');
    assert.equal(page.price, money(cartVariant.price));
  }
});

test('catálogo, ficha y sorteo comparten mínimo de variantes aunque no tengan stock', () => {
  const fragrance = { ...product, active: true, categoryIds: ['colonias'], basePrice: 90000 };
  const variants = [variant('first', 55000, { order: 0 }),
    variant('cheapest', 40000, { order: 1, stock: 0, commercialStatus: 'agotado' }),
    variant('deleted', 1000, { deleted: true }), variant('invalid', 0)];
  const giveaway = selectGiveawayProduct(fragrance, variants, [{ id: 'colonias', name: 'Colonias' }]);
  assert.equal(giveaway.productPrice, 40000);
  assert.equal(giveaway.variantId, 'cheapest');
  assert.equal(render(CARD, { item: fragrance, variants }).price, `Desde ${money(giveaway.productPrice)}`);
  assert.equal(render(PAGE, { item: fragrance, variants }).price, `Desde ${money(giveaway.productPrice)}`);
});

test('selección mínima y desempate son iguales aunque Firestore entregue otro orden', () => {
  const variants = [variant('z', 30000, { order: 2 }), variant('a', 30000, { order: 2 }),
    variant('first', 60000, { order: 0 })];
  for (const input of [variants, [...variants].reverse()]) {
    assert.equal(getProductPriceSummary(product, input).mainVariant.id, 'a');
  }
});
