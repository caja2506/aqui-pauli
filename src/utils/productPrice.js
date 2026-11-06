import { availableQuantity } from '../../functions/lib/catalogSafety.mjs';
export { getVariantPrice, isActiveVariant,
  getCatalogPriceSummary as getProductPriceSummary } from '../../functions/lib/catalogPrice.mjs';

export function isPurchasableVariant(variant, product, quantity = 1) {
  return Number.isSafeInteger(quantity) && quantity > 0 && availableQuantity(product, variant) >= quantity;
}

