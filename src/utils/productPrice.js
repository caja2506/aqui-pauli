import { normalizeCommercialStatus } from './constants.js';
import { isActiveVariant } from '../../functions/lib/catalogPrice.mjs';
export { getVariantPrice, isActiveVariant,
  getCatalogPriceSummary as getProductPriceSummary } from '../../functions/lib/catalogPrice.mjs';

export function isPurchasableVariant(variant) {
  return isActiveVariant(variant)
    && ['disponible', 'bajo_pedido'].includes(normalizeCommercialStatus(variant.commercialStatus));
}

