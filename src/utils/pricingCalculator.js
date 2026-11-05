// Ganancia = recargo sobre el costo, no margen sobre el precio de venta.
export const PRICE_ROUNDING_STEPS = [1, 100, 500, 1000];
export const DEFAULT_PRICING_SETTINGS = Object.freeze({ version: 2, markupPercent: 20, roundingStep: 100, localShippingCRC: 2900, internationalShippingCRC: 7000 });
const MAX_COST = 1000000000;

function number(value, label, { min = 0, max = MAX_COST, optional = false } = {}) {
  if (value === '' || value == null) {
    if (optional) return 0;
    throw new Error(`Ingresá ${label}.`);
  }
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') {
    throw new Error(`Revisá ${label}.`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new Error(`Revisá ${label}: debe estar entre ${min} y ${max}.`);
  }
  return result;
}

export function validatePricingSettings(input) {
  const markupPercent = number(input.markupPercent, 'la ganancia estándar', { max: 1000 });
  const roundingStep = number(input.roundingStep, 'el redondeo');
  if (!PRICE_ROUNDING_STEPS.includes(roundingStep)) throw new Error('Seleccioná un redondeo válido.');
  return { markupPercent, roundingStep };
}

export function validateWorkbenchSettings(input) {
  const base = validatePricingSettings(input);
  return { version: 2, ...base,
    localShippingCRC: number(input.localShippingCRC, 'el envío nacional'),
    internationalShippingCRC: number(input.internationalShippingCRC, 'el traslado internacional'),
  };
}

export function loadWorkbenchSettings(saved) {
  // La nueva política solicitada reemplaza el estándar de la calculadora v1.
  return saved?.version === 2 ? validateWorkbenchSettings(saved) : { ...DEFAULT_PRICING_SETTINGS };
}

export function filterSupplierProducts(products, query) {
  const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  return products.filter(product => words.every(word => normalize(product.description).includes(word)));
}

export function supplierPrice(product, payment) {
  if (!['cash', 'card'].includes(payment)) throw new Error('Seleccioná efectivo o SINPE/tarjeta.');
  return number(payment === 'card' ? product.cardCRC : product.cashCRC, 'el precio mayorista', { min: 0.01 });
}

export function calculateSellingPrice(input, settings) {
  const { markupPercent, roundingStep } = validatePricingSettings(settings);
  if (!['CRC', 'USD'].includes(input.currency)) throw new Error('Seleccioná colones o dólares.');
  const baseCost = number(input.baseCost, 'el costo base', { min: 0.01 });
  const exchangeRate = input.currency === 'USD'
    ? number(input.exchangeRate, 'el tipo de cambio', { min: 0.01, max: 100000 }) : 1;
  const purchaseCRC = baseCost * exchangeRate;
  const inboundShipping = number(input.inboundShipping, 'el envío del proveedor', { optional: true });
  const delivery = number(input.delivery, 'la entrega al cliente', { optional: true });
  const otherCosts = number(input.otherCosts, 'los otros costos', { optional: true });
  // Round costs up to a céntimo, then the suggested price up to the chosen CRC step.
  const totalCost = Math.ceil((purchaseCRC + inboundShipping + delivery + otherCosts) * 100 - 1e-7) / 100;
  if (totalCost > MAX_COST) throw new Error('El costo total supera el máximo permitido.');
  const targetProfit = totalCost * markupPercent / 100;
  const unroundedPrice = totalCost + targetProfit;
  const suggestedPrice = Math.ceil(unroundedPrice / roundingStep - 1e-10) * roundingStep;
  const profit = suggestedPrice - totalCost;
  return {
    purchaseCRC, inboundShipping, delivery, otherCosts, totalCost, targetProfit,
    unroundedPrice, suggestedPrice, profit,
    marginPercent: suggestedPrice > 0 ? profit / suggestedPrice * 100 : 0,
  };
}
