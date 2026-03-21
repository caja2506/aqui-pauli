import { GAM_CANTONES, EXPRESS_CANTONES } from '../utils/constants';

/**
 * Precios de envío (CRC) — configurables, se podrían mover a Firestore config/shipping
 */
const SHIPPING_PRICES = {
  normalGAM: 3500,
  normalOutside: 5500,
  expressGrecia: 2000,
};

/**
 * Determina si un cantón está dentro del GAM
 */
export function isInGAM(canton) {
  if (!canton) return false;
  return GAM_CANTONES.some(
    gam => gam.toLowerCase() === canton.toLowerCase()
  );
}

/**
 * Verifica si un cantón tiene envío express disponible
 */
export function hasExpressAvailable(canton) {
  if (!canton) return false;
  return EXPRESS_CANTONES.some(
    e => e.toLowerCase() === canton.toLowerCase()
  );
}

/**
 * Calcula el costo de envío según cantón y tipo
 */
export function calculateShippingCost(canton, shippingType = 'normal') {
  if (shippingType === 'express' && hasExpressAvailable(canton)) {
    return SHIPPING_PRICES.expressGrecia;
  }

  if (isInGAM(canton)) {
    return SHIPPING_PRICES.normalGAM;
  }

  return SHIPPING_PRICES.normalOutside;
}

/**
 * Retorna las opciones de envío disponibles para un cantón
 */
export function getShippingOptions(canton) {
  const options = [
    {
      type: 'normal',
      label: 'Envío Normal (Correos de Costa Rica)',
      price: isInGAM(canton) ? SHIPPING_PRICES.normalGAM : SHIPPING_PRICES.normalOutside,
      estimatedDays: isInGAM(canton) ? '2-4 días hábiles' : '4-7 días hábiles',
    },
  ];

  if (hasExpressAvailable(canton)) {
    options.unshift({
      type: 'express',
      label: 'Envío Express (Solo Grecia)',
      price: SHIPPING_PRICES.expressGrecia,
      estimatedDays: '1-2 días hábiles',
    });
  }

  return options;
}
