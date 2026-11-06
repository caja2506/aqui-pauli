import { isSaleDecant } from './decantSale.mjs';

// IDs estables de las categorías de perfumes completos de esta tienda.
const PERFUME_CATEGORIES = new Set(['tEunA0AXM35keXWWcz2P', 'LTD4HApgXSUBRmJt0ZVo', 'd7002zlsGNkSBbQpYnGw']);
export function isFullPerfume(product) {
  return !isSaleDecant(product) && (product?.productKind === 'perfume'
    || (product?.categoryRefs || []).some(ref => PERFUME_CATEGORIES.has(ref?.id || String(ref).split('/').at(-1))));
}

// Umbrales de seguridad, no precios sugeridos ni cálculo de rentabilidad.
export function minimumCatalogPrice(product) { return isFullPerfume(product) ? 10000 : 1000; }
export function maximumProductQuantity(product) { return isFullPerfume(product) ? 1 : 99; }

export function availableQuantity(product, variant) {
  if (!variant || product?.active === false || product?.deleted || variant.active === false || variant.deleted) return 0;
  const status = String(variant.commercialStatus ?? 'disponible').toLowerCase().trim().replace(/\s+/g, '_');
  const supply = variant.supplyType ?? product?.supplyType ?? 'stock_propio';
  if (!['disponible', 'bajo_pedido'].includes(status)) return 0;
  if (supply === 'bajo_pedido') return isFullPerfume(product) || isSaleDecant(product) ? 0 : 99;
  if (supply !== 'stock_propio' || !Number.isSafeInteger(variant.stock) || variant.stock < 0) return 0;
  const reserved = variant.reservedStock ?? 0;
  if (typeof reserved !== 'number' || !Number.isFinite(reserved)) return 0;
  return Math.min(maximumProductQuantity(product), Math.max(0, variant.stock - Math.max(0, Math.ceil(reserved))));
}
