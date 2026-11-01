import { normalizeCommercialStatus } from './constants.js';
import { isSaleDecant } from '../../functions/lib/decantSale.mjs';
import { isActiveVariant } from '../../functions/lib/catalogPrice.mjs';
export { getVariantPrice, isActiveVariant,
  getCatalogPriceSummary as getProductPriceSummary } from '../../functions/lib/catalogPrice.mjs';

export function isPurchasableVariant(variant, product, quantity = 1) {
  if (!isActiveVariant(variant)) return false;
  const status = normalizeCommercialStatus(variant.commercialStatus);
  if (!isSaleDecant(product)) return ['disponible', 'bajo_pedido'].includes(status);
  const reserved = Number.isFinite(variant.reservedStock) ? Math.max(0, Math.ceil(variant.reservedStock)) : 0;
  return status === 'disponible' && (variant.supplyType ?? product.supplyType ?? 'stock_propio') === 'stock_propio'
    && Number.isSafeInteger(variant.stock) && variant.stock - reserved >= quantity;
}

