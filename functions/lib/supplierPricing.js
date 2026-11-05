"use strict";

class PricingAdminError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = message => { throw new PricingAdminError('invalid-argument', message); };

function validateSupplierCatalog(input) {
  if (!input || input.version !== 1 || input.currency !== 'CRC' || input.supplier !== 'LS') fail('El archivo no es un catálogo LS válido en colones.');
  if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > 3000) fail('El catálogo debe contener entre 1 y 3.000 productos.');
  if (typeof input.sourceName !== 'string' || input.sourceName.length < 1 || input.sourceName.length > 200
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.sourceDate || '') || !/^[a-f0-9]{64}$/.test(input.sourceSha256 || '')) fail('Falta la identificación del PDF de origen.');
  const ids = new Set();
  const products = input.products.map((row, index) => {
    if (!row || !/^ls-\d{4}$/.test(row.id || '') || ids.has(row.id)
      || typeof row.description !== 'string' || !row.description.trim() || row.description.length > 300
      || !Number.isInteger(row.page) || row.page < 1 || row.page > 500
      || ![row.cashCRC, row.cardCRC].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1e9)) fail(`Revisá la fila ${index + 1} del catálogo.`);
    ids.add(row.id);
    return { id: row.id, description: row.description, cashCRC: row.cashCRC, cardCRC: row.cardCRC, page: row.page };
  });
  const result = { version: 1, supplier: 'LS', sourceName: input.sourceName, sourceDate: input.sourceDate,
    sourceSha256: input.sourceSha256, currency: 'CRC', products, count: products.length };
  if (Buffer.byteLength(JSON.stringify(result)) > 750000) fail('El catálogo supera el tamaño permitido.');
  return result;
}

// Tiendas concretas: jamás se consultan hosts arbitrarios ni redes internas.
const STORES = Object.freeze({
  'amazon.com': 'Amazon', 'www.amazon.com': 'Amazon',
  'jomashop.com': 'Jomashop', 'www.jomashop.com': 'Jomashop',
  'fragrancenet.com': 'FragranceNet', 'www.fragrancenet.com': 'FragranceNet',
  'fragrancex.com': 'FragranceX', 'www.fragrancex.com': 'FragranceX',
});
function validateExternalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('Pegá un enlace válido del producto.');
  let url;
  try { url = new URL(value); } catch { fail('Pegá un enlace completo que empiece con https://.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !Object.hasOwn(STORES, url.hostname)) {
    fail('La consulta automática admite Amazon.com, Jomashop, FragranceNet y FragranceX con enlaces HTTPS directos.');
  }
  if (url.pathname === '/' || /(?:^|\/)(?:login|signin|account|checkout|cart)(?:\/|$)/i.test(url.pathname)) fail('Usá el enlace de un producto, no una cuenta, carrito o página de inicio.');
  url.hash = '';
  // No enviar parámetros de sesión ni tokens de enlaces compartidos.
  url.search = '';
  return url;
}

function decodeText(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '').slice(0, 240);
}
const types = (item, type) => [item?.['@type']].flat().some(value => value === type || value === `https://schema.org/${type}` || value === `http://schema.org/${type}`);
function extractProductOffers(html) {
  const offers = [];
  function add(product, offer) {
    // Un rango desde lowPrice o cuotas no se transforma en un precio exacto.
    if (!types(offer, 'Offer') || Array.isArray(offer.price)) return;
    const raw = String(offer.price ?? '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return;
    const amount = Number(raw);
    const currency = offer.priceCurrency;
    if (!['USD', 'CRC'].includes(currency) || amount <= 0 || amount > 1e9) return;
    if (offer.priceValidUntil && Date.parse(offer.priceValidUntil) < Date.now() - 86400000) return;
    const availability = String(offer.availability || '');
    if (/OutOfStock|SoldOut|Discontinued/.test(availability)) return;
    const title = decodeText(product.name);
    if (!title) return;
    const label = [title, decodeText(offer.name), decodeText(offer.seller?.name)].filter(Boolean).join(' · ');
    const key = JSON.stringify([label, amount, currency]);
    if (!offers.some(row => row.key === key)) offers.push({ key, title: label, amount, currency });
  }
  function visit(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12 || offers.length >= 20) return;
    if (Array.isArray(node)) { node.slice(0, 200).forEach(value => visit(value, depth + 1)); return; }
    if (types(node, 'Product')) {
      const rawOffers = [node.offers].flat().filter(Boolean);
      for (const offer of rawOffers) {
        if (types(offer, 'AggregateOffer')) [offer.offers].flat().filter(Boolean).forEach(item => add(node, item));
        else add(node, offer);
      }
    }
    if (node['@graph']) visit(node['@graph'], depth + 1);
    if (node.mainEntity) visit(node.mainEntity, depth + 1);
    if (node.hasVariant) visit(node.hasVariant, depth + 1);
  }
  const scripts = html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    try { visit(JSON.parse(match[1])); } catch { /* malformed structured data is ignored */ }
  }
  return offers.slice(0, 20).map(({ key, ...offer }, index) => ({ id: String(index), ...offer }));
}

async function readBoundedHtml(response) {
  if (!(response.headers.get('content-type') || '').includes('text/html')) throw new PricingAdminError('unavailable', 'La tienda no entregó una página de producto legible.');
  const maxBytes = 2 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) throw new PricingAdminError('unavailable', 'La página es demasiado grande para consultar el precio.');
  const reader = response.body.getReader();
  let bytes = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new PricingAdminError('unavailable', 'La página es demasiado grande para consultar el precio.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

async function lookupPrice(value, fetchFn = fetch) {
  let url = validateExternalUrl(value);
  if (STORES[url.hostname] === 'Amazon') return { status: 'manual_required', store: 'Amazon', url: url.href, offers: [],
    message: 'Amazon no tiene una conexión automática configurada. Abrí el producto y copiá su precio; el traslado de ₡7.000 se calcula aquí.' };
  const originalStore = STORES[url.hostname];
  const signal = AbortSignal.timeout(12000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchFn(url.href, { redirect: 'manual', signal, headers: { Accept: 'text/html', 'User-Agent': 'AquiPauli-PriceLookup/1.0' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects === 3 || !response.headers.get('location')) break;
      url = validateExternalUrl(new URL(response.headers.get('location'), url).href);
      if (STORES[url.hostname] !== originalStore) fail('La tienda redirigió a otro sitio. Usá el enlace final del producto.');
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: 'manual_required', url: url.href, store: originalStore, offers: [], message: 'La tienda no permitió consultar el precio. Abrí el enlace e ingresalo manualmente.' };
    }
    const html = await readBoundedHtml(response);
    if (/verify you are human|captcha|checking your browser|access denied|unusual traffic/i.test(html)) {
      return { status: 'manual_required', url: url.href, store: originalStore, offers: [], message: 'La tienda requiere verificación en su página. Ingresá el precio manualmente.' };
    }
    const offers = extractProductOffers(html);
    return { status: offers.length ? 'found' : 'manual_required', url: url.href, store: originalStore, offers,
      checkedAt: new Date().toISOString(), message: offers.length ? 'Revisá presentación, moneda y precio antes de usarlo.' : 'La página no publicó un precio exacto que podamos leer. Ingresalo manualmente.' };
  }
  throw new PricingAdminError('unavailable', 'No pudimos llegar a la página del producto. Podés ingresar el precio manualmente.');
}

function createPricingHandlers({ db, fetchFn = fetch, now = () => Date.now() }) {
  async function requireAdmin(req) {
    if (!req.auth?.uid || (await db.collection('users_roles').doc(req.auth.uid).get()).data()?.role !== 'admin') {
      throw new PricingAdminError('permission-denied', 'Solo administradores pueden usar precios de proveedores.');
    }
  }
  return {
    importSupplierCatalog: async req => {
      await requireAdmin(req);
      const catalog = validateSupplierCatalog(req.data);
      await db.collection('admin_supplier_catalogs').doc('ls').set({ ...catalog, importedAt: new Date(now()).toISOString() });
      return { count: catalog.count, sourceName: catalog.sourceName };
    },
    lookupExternalPrice: async req => {
      await requireAdmin(req);
      const url = validateExternalUrl(req.data?.url);
      const ref = db.collection('admin_pricing_requests').doc(req.auth.uid);
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const last = snap.exists ? Number(snap.data().lastAtMs) : 0;
        if (last && now() - last < 10000) throw new PricingAdminError('resource-exhausted', 'Esperá 10 segundos entre consultas.');
        tx.set(ref, { lastAtMs: now() });
      });
      return lookupPrice(url.href, fetchFn);
    },
    getPricingExchangeRate: async req => {
      await requireAdmin(req);
      const response = await fetchFn('https://api.hacienda.go.cr/indicadores/tc/dolar', { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new PricingAdminError('unavailable', 'No pudimos consultar el tipo de cambio. Ingresá el que te cobra tu banco.');
      const data = await response.json();
      const rate = Number(data?.venta?.valor);
      if (!(rate > 100 && rate < 2000)) throw new PricingAdminError('unavailable', 'La referencia de tipo de cambio no es válida.');
      return { rate, date: data.venta.fecha || null, source: 'Venta BCCR vía Hacienda', checkedAt: new Date(now()).toISOString() };
    },
  };
}
module.exports = { PricingAdminError, validateSupplierCatalog, validateExternalUrl, extractProductOffers, lookupPrice, createPricingHandlers };
