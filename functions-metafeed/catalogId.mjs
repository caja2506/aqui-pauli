// El catálogo de Meta identifica variantes por SKU. Sin SKU usa ambos IDs de Firestore.
export function getCatalogId(productId, variant) {
  if (!variant) return String(productId);
  return String(variant.sku || `${productId}-${variant.id}`).trim();
}
