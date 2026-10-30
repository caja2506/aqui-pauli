// Política compartida por el selector web y enterGiveaway. No depende de Auth,
// Firestore ni inventario: recibe documentos del catálogo ya leídos por cada capa.
import { getCatalogPriceSummary } from './catalogPrice.mjs';

const DEFAULT_FRAGRANCE_NAMES = ['perfume', 'perfumes', 'colonia', 'colonias', 'perfumeria', 'fragancia', 'fragancias'];
const normalize = (value) => typeof value === 'string'
  ? value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase() : '';
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function referenceId(reference) {
  if (typeof reference === 'string') return validId(reference) ? reference : '';
  if (!reference || typeof reference !== 'object') return '';
  if (typeof reference.path === 'string') {
    const match = /^categories\/([A-Za-z0-9_-]{1,128})$/.exec(reference.path);
    return match?.[1] || '';
  }
  return validId(reference.id) ? reference.id : '';
}

export function isFragranceProduct(product, categories, policy = {}) {
  if (!product || !Array.isArray(categories)) return false;
  const names = new Set((policy.fragranceCategoryNames || DEFAULT_FRAGRANCE_NAMES).map(normalize));
  const byId = new Map(categories.filter((category) => category && validId(category.id))
    .map((category) => [category.id, category]));
  const refs = [...(Array.isArray(product.categoryRefs) ? product.categoryRefs : []),
    ...(Array.isArray(product.categoryIds) ? product.categoryIds : [])];
  return refs.some((reference) => {
    let id = referenceId(reference);
    const visited = new Set();
    while (id && !visited.has(id)) {
      visited.add(id);
      const category = byId.get(id);
      if (!category) return false;
      if (names.has(normalize(category.name)) || names.has(normalize(category.slug))) return true;
      id = referenceId(category.parentId);
    }
    return false;
  });
}

export function selectGiveawayProduct(product, variants, categories, policy = {}) {
  if (!product || !validId(product.id) || product.active !== true || product.deleted || product.unlisted
      || typeof product.name !== 'string' || !product.name.trim() || product.name.length > 300
      || /[\u0000-\u001f\u007f]/.test(product.name)
      || !Array.isArray(variants) || !isFragranceProduct(product, categories, policy)) return null;

  // Mismo precio mínimo anunciado por tarjeta y ficha sin selección. La elección
  // del sorteo admite productos sin stock: su disponibilidad no cambia el precio.
  const { mainVariant: variant, price } = getCatalogPriceSummary(product, variants);
  const limit = policy.priceLimitCRC ?? 50000;
  // La tienda muestra colones enteros. Un precio que redondea a ₡50 000 tampoco
  // debe aparecer elegible. Stock, abastecimiento y commercialStatus no intervienen.
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0
      || typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0
      || price >= limit || Math.round(price) >= limit) return null;
  return {
    productId: product.id,
    productName: product.name.trim(),
    productPrice: price,
    variantId: variant && validId(variant.id) ? variant.id : '',
    variantName: typeof variant?.name === 'string' ? variant.name.trim().slice(0, 300) : '',
  };
}
