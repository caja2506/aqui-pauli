// Los dos umbrales usan el subtotal de productos antes del descuento y del envío.
export const DECANT_CATEGORY = 'decants';
export const DECANT_MINIMUM = 8000;
export const FREE_DECANT_SHIPPING = 25000;
export const DECANT_SHIPPING = 2500;
export const MINIMUM_MESSAGE = 'El pedido mínimo de solo decants es de ₡8.000.';

export function isSaleDecant(product) {
  return product?.productKind === 'decant' || product?.categoryRefs?.some(ref => (ref?.id || ref) === DECANT_CATEGORY) === true;
}

export function decantDelivery(onlyDecants, subtotal) {
  const toFreeShipping = onlyDecants ? Math.max(0, FREE_DECANT_SHIPPING - subtotal) : 0;
  return {
    toFreeShipping,
    belowMinimum: onlyDecants && subtotal < DECANT_MINIMUM,
    shippingCost: toFreeShipping > 0 ? DECANT_SHIPPING : 0,
  };
}

export function cartDecantDelivery(items, subtotal) {
  // Los carritos guardados por versiones anteriores no llevan productKind.
  return decantDelivery(items.length > 0 && items.every(item => item.productKind === 'decant'
    || (!item.productKind && item.productId?.startsWith('decant-'))), subtotal);
}
