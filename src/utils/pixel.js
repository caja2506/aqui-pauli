import { getCatalogId } from '../../functions/lib/catalogId.mjs';

const PIXEL_ID = '1746566943106831';
let lastPage;
let initialized = false;
const purchases = new Set();

function canTrack() {
  if (typeof window === 'undefined') return false;
  const { hostname, search, hash } = window.location;
  return ['aquipauli.com', 'aqui-pauli.web.app'].includes(hostname)
    && !/[?&#](?:oobCode|access_token|id_token|tilopay-pilot)=/i.test(search + hash);
}

function initialize() {
  if (initialized) return;
  if (!window.fbq) {
    // Cola del snippet de Meta: los eventos esperan mientras se carga el SDK.
    function fbq(...args) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue.push(args);
    }
    Object.assign(fbq, { push: fbq, loaded: true, version: '2.0', queue: [] });
    window.fbq = fbq;
    window._fbq ||= fbq;
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(script);
  }
  // React Router owns PageView. Disable the SDK's second history listener and automatic form events.
  window.fbq.disablePushState = true;
  window.fbq('set', 'autoConfig', false, PIXEL_ID);
  window.fbq('init', PIXEL_ID);
  initialized = true;
}

export function track(event, data, eventID) {
  if (!canTrack() || typeof window.fbq !== 'function') return false;
  try {
    if (eventID) window.fbq('track', event, data, { eventID });
    else if (data) window.fbq('track', event, data);
    else window.fbq('track', event);
    return true;
  } catch { return false; }
}

export function trackPageView(page) {
  if (page === lastPage) return;
  lastPage = page;
  if (!canTrack()) return;
  try {
    if (!initialized) {
      initialize();
      track('PageView');
    } else {
      // track('PageView') se deduplica por documento en el SDK. Cada ruta de la SPA es otra visita.
      window.fbq('trackSingle', PIXEL_ID, 'PageView');
    }
  } catch { /* Tracking must not interrupt navigation. */ }
}

export function productEvent(product, variant, price, quantity = 1) {
  const id = getCatalogId(product.id, variant);
  return { content_type: 'product', currency: 'CRC', content_ids: [id],
    contents: [{ id, quantity, item_price: price }], value: price * quantity };
}

export function trackWhatsAppClick(event) {
  const link = event.target?.closest?.('a[href^="https://wa.me/"]');
  if (link && !/^\/(admin|orden-confirmada|tilopay|mi-cuenta)(\/|$)/.test(window.location.pathname)) track('Contact');
}

export function isPurchase(order) {
  if (!order || order.isTest || order.test || order.testOrder || order.isTestOrder || order.testMode || order.sandbox
    || [order.mode, order.environment, order.paypal?.env, order.tilopay?.mode].some(mode => ['test', 'sandbox'].includes(mode))
    || ['cancelado', 'revision_manual', 'reembolsado'].includes(order.status)
    || ['test_paid', 'rechazado', 'reembolsado'].includes(order.paymentStatus)
    || order.itemsSummary?.some(item => /^zz-tilopay-/i.test(item.productId) || item.productId === 'prueba-whatsapp-1')) return false;
  if (['sinpe', 'sinpe_movil', 'transferencia', 'contra_entrega', 'whatsapp'].includes(order.paymentMethod)) return true;
  if (!['pagado', 'verificado', 'parcial'].includes(order.paymentStatus)) return false;
  if (order.paymentMethod === 'paypal') return order.paypal?.env === 'live'
    && order.paypal.captureStatus === 'COMPLETED' && Boolean(order.paypal.captureId);
  if (order.paymentMethod === 'tilopay') return order.tilopay?.mode === 'live'
    && order.tilopay.status === 'approved' && ['prod', 'production'].includes(String(order.reconciliationDetails?.environment).trim().toLowerCase());
  return false;
}

// Los pedidos y carritos históricos pueden no tener SKU. Resolver desde la variante antes de emitir.
export async function cartEvent(lines, value, readVariant) {
  if (!lines?.length || !Number.isFinite(value) || value < 0) return null;
  const contents = await Promise.all(lines.map(async line => {
    const quantity = line.quantity, price = line.price ?? line.unitPrice;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || !Number.isFinite(price) || price < 0 || !line.productId) return null;
    let id = line.catalogId;
    if (!id && line.variantId) {
      const variant = await readVariant(line.productId, line.variantId);
      if (!variant) return null;
      id = getCatalogId(line.productId, variant);
    }
    return { id: String(id || getCatalogId(line.productId)), quantity, item_price: price };
  }));
  if (contents.some(item => !item)) return null;
  return { content_type: 'product', currency: 'CRC', contents, content_ids: contents.map(item => item.id),
    num_items: contents.reduce((sum, item) => sum + item.quantity, 0), value };
}

export function purchaseTracked(id) {
  if (purchases.has(id)) return true;
  try { return window.localStorage.getItem(`pixel_purchase_${id}`) === '1'; } catch { return false; }
}

export async function trackPurchase(id, order, readVariant, isCurrent, readOrderItems) {
  if (!canTrack() || !isPurchase(order) || purchaseTracked(id)) return;
  const lines = order.itemsSummary?.length ? order.itemsSummary : await readOrderItems?.(id);
  if (!isCurrent() || !isPurchase({ ...order, itemsSummary: lines })) return;
  const data = await cartEvent(lines, order.total, readVariant);
  function send() {
    if (!data || !isCurrent() || purchaseTracked(id) || !track('Purchase', data, id)) return;
    purchases.add(id);
    try { window.localStorage.setItem(`pixel_purchase_${id}`, '1'); } catch { /* In-memory fallback. */ }
  }
  if (window.navigator.locks) await window.navigator.locks.request(`pixel_purchase_${id}`, send);
  else send();
}
