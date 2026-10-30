// Render the actual home/catalog JSX and run the real page-title effect.
// Collection reads and child cards are fixtures: no Firebase or network calls.
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
const HOME = 'src/pages/store/HomePage.jsx';
const CATALOG = 'src/pages/store/CatalogPage.jsx';
const TITLE = 'src/hooks/usePageTitle.js';
const abs = (relative) => path.join(root, relative);
const compiled = new Map(await Promise.all([HOME, CATALOG, TITLE].map(async (relative) => {
  const filename = abs(relative);
  const { code } = await transformWithEsbuild(await readFile(filename, 'utf8'), filename, {
    loader: filename.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic',
    format: 'cjs', target: 'es2022', sourcemap: false,
  });
  return [filename, code];
})));

function renderPage(relative, options = {}) {
  const effects = [];
  const cleanups = [];
  const cache = new Map();
  const modules = new Map([
    [abs('src/hooks/useCollection.js'), { useCollection: (name) => ({
      data: name === 'products' ? options.products || [] : [],
      loading: Boolean(options.loading), error: options.error || null,
      retry: () => { throw new Error('No data retries in a render test'); },
    }) }],
    [abs('src/components/storefront/ProductCard.js'), { __esModule: true, default: ({ product }) => React.createElement('article', null, product.name) }],
    [abs('src/components/storefront/GiveawayBanner.js'), { __esModule: true, default: () => null }],
    [abs('src/components/ui/LoadError.js'), { __esModule: true, default: () => React.createElement('p', { role: 'alert' }, 'No se pudo cargar el catálogo') }],
    [abs('src/components/ui/EmptyState.js'), { __esModule: true, default: ({ title, message }) => React.createElement('section', null, title, message) }],
  ]);

  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    assert.ok(compiled.has(filename), `Unexpected source import: ${path.relative(root, filename)}`);
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = (name) => {
      if (name === 'react' && filename === abs(TITLE)) return {
        ...React,
        useEffect(effect, dependencies) {
          effects.push(effect);
          React.useEffect(effect, dependencies);
        },
      };
      if (['react', 'react/jsx-runtime', 'react-router-dom', 'lucide-react'].includes(name)) return require(name);
      assert.ok(name.startsWith('.'), `Unexpected external import: ${name}`);
      const target = path.resolve(path.dirname(filename), name);
      const candidates = path.extname(target) ? [target] : [`${target}.js`, `${target}.jsx`];
      const found = candidates.find((candidate) => modules.has(candidate) || compiled.has(candidate));
      assert.ok(found, `Unresolved import: ${name}`);
      return load(found);
    };
    new Function('require', 'module', 'exports', compiled.get(filename))(localRequire, module, module.exports);
    return module.exports;
  }

  const Component = load(abs(relative)).default;
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Component)));
  return {
    html,
    mountEffects() { effects.forEach((effect) => cleanups.push(effect())); },
    unmount() { cleanups.forEach((cleanup) => cleanup?.()); },
  };
}

const withDocument = (run) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { title: 'Aquí Pauli' };
  try { run(); } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  }
};

test('home y catálogo muestran títulos distintos al navegar, sin dejar el anterior al desmontarse', () => {
  withDocument(() => {
    const product = { id: 'versace', name: 'Versace Eros EDT', active: true };
    const home = renderPage(HOME, { products: [product] });
    assert.match(home.html, /Productos Destacados/);
    assert.match(home.html, /Versace Eros EDT/);
    assert.match(home.html, /href="\/catalogo"/);
    home.mountEffects();
    assert.equal(document.title, 'Aquí Pauli | Tienda online en Costa Rica');
    home.unmount();
    assert.equal(document.title, 'Aquí Pauli');

    const catalog = renderPage(CATALOG, { products: [product] });
    assert.match(catalog.html, /<h1[^>]*>Catálogo<\/h1>/);
    assert.match(catalog.html, /Versace Eros EDT/);
    catalog.mountEffects();
    assert.equal(document.title, 'Catálogo | Aquí Pauli');
    catalog.unmount();
    assert.equal(document.title, 'Aquí Pauli');
  });
});

test('los títulos de home y catálogo también se aplican mientras carga Firestore o si falla la consulta', () => {
  withDocument(() => {
    for (const options of [{ loading: true }, { error: new Error('Fixture') }]) {
      for (const [relative, title] of [[HOME, 'Aquí Pauli | Tienda online en Costa Rica'], [CATALOG, 'Catálogo | Aquí Pauli']]) {
        const page = renderPage(relative, options);
        page.mountEffects();
        assert.equal(document.title, title);
        if (options.error) assert.match(page.html, /role="alert"/);
        page.unmount();
      }
    }
  });
});

test('el hook de título no requiere document durante renderizado sin navegador', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  delete globalThis.document;
  try {
    const page = renderPage(HOME);
    assert.doesNotThrow(() => page.mountEffects());
    assert.doesNotThrow(() => page.unmount());
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
  }
});
