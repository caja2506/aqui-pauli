import { GAM_CANTONES, EXPRESS_CANTONES } from '../utils/constants';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Precios de envío por defecto (CRC)
 */
const DEFAULT_SHIPPING_PRICES = {
  normalGAM: 3500,
  normalOutside: 5500,
  expressGrecia: 2000,
};

// Cache en memoria
let cachedPrices = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60000; // 1 minuto

/**
 * Obtener precios de envío desde Firestore (con cache)
 */
export async function getShippingPrices() {
  const now = Date.now();
  if (cachedPrices && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedPrices;
  }

  try {
    const snap = await getDoc(doc(db, 'config', 'shipping'));
    if (snap.exists()) {
      cachedPrices = { ...DEFAULT_SHIPPING_PRICES, ...snap.data() };
    } else {
      cachedPrices = { ...DEFAULT_SHIPPING_PRICES };
    }
  } catch (err) {
    console.error('Error cargando precios de envío:', err);
    cachedPrices = { ...DEFAULT_SHIPPING_PRICES };
  }
  cacheTimestamp = now;
  return cachedPrices;
}

/**
 * Guardar precios de envío en Firestore (admin)
 */
export async function saveShippingPrices(prices) {
  await setDoc(doc(db, 'config', 'shipping'), {
    normalGAM: prices.normalGAM,
    normalOutside: prices.normalOutside,
    expressGrecia: prices.expressGrecia,
    updatedAt: new Date().toISOString(),
  });
  // Invalidar cache
  cachedPrices = null;
  cacheTimestamp = 0;
}

/**
 * Precios síncronos (usa cache o defaults)
 */
function getPricesSync() {
  return cachedPrices || DEFAULT_SHIPPING_PRICES;
}

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
  const prices = getPricesSync();

  if (shippingType === 'express' && hasExpressAvailable(canton)) {
    return prices.expressGrecia;
  }

  if (isInGAM(canton)) {
    return prices.normalGAM;
  }

  return prices.normalOutside;
}

/**
 * Retorna las opciones de envío disponibles para un cantón
 */
export function getShippingOptions(canton) {
  const prices = getPricesSync();
  const options = [
    {
      type: 'normal',
      label: 'Envío Normal (Correos de Costa Rica)',
      price: isInGAM(canton) ? prices.normalGAM : prices.normalOutside,
      estimatedDays: isInGAM(canton) ? '2-4 días hábiles' : '4-7 días hábiles',
    },
  ];

  if (hasExpressAvailable(canton)) {
    options.unshift({
      type: 'express',
      label: 'Envío Express (Solo Grecia)',
      price: prices.expressGrecia,
      estimatedDays: '1-2 días hábiles',
    });
  }

  return options;
}
