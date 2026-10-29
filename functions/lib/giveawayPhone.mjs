// La misma normalización y validación se usa en el formulario y en enterGiveaway.
export const GIVEAWAY_PHONE_ERROR = 'Ingresá un teléfono de Costa Rica de 8 dígitos que empiece con 2, 4, 5, 6, 7 u 8.';

export function normalizeGiveawayPhone(value) {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/[\s-]/g, '');
  if (compact.startsWith('+506')) return compact.slice(4);
  // Un número local válido, como 50612345, no contiene un prefijo de país.
  if (compact.startsWith('506') && compact.length > 8) return compact.slice(3);
  return compact;
}

export function isValidGiveawayPhone(value) {
  return /^[245678][0-9]{7}$/.test(normalizeGiveawayPhone(value));
}
