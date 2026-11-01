import { isSaleDecant } from './decantSale.mjs';

export const PERFUMES = 'tEunA0AXM35keXWWcz2P';
const perfumeCategories = new Set([PERFUMES, 'LTD4HApgXSUBRmJt0ZVo', 'd7002zlsGNkSBbQpYnGw']);

export function activeSamples(config) {
  if (config?.promoActive !== true || !Array.isArray(config.options)) return [];
  return config.options.filter(o => o?.active === true && typeof o.name === 'string' && /^[a-z0-9-]+$/.test(o.id) && o.id !== 'sorpresa')
    .sort((a, b) => a.order - b.order);
}

export async function containsPerfume(products, readParent) {
  const ids = [...new Set(products.filter(p => !isSaleDecant(p)).flatMap(p => (p?.categoryRefs || []).map(ref => ref?.id || ref).filter(id => typeof id === 'string' && /^[\w-]+$/.test(id))))];
  if (ids.some(id => perfumeCategories.has(id))) return true;
  const parents = await Promise.all(ids.map(readParent));
  return parents.some(id => id === PERFUMES);
}

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 80) return '';
  const match = /^AP-?([A-HJKMNP-Z2-9]{6})$/.exec(input.toUpperCase().replace(/\s/g, ''));
  return match ? 'AP-' + match[1] : '';
}

export function cardState(card, now = Date.now()) {
  if (card.used) return 'Usados';
  if (!(Date.parse(card.expiresAt) > now)) return 'Vencidos';
  return card.printed ? 'Impresos' : 'Por imprimir';
}
