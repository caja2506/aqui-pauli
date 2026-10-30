// Precio público del catálogo, compartido por la tienda y el sorteo.
// La disponibilidad determina si una variante se puede comprar, no su precio.
function priceMinor(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'number' && !Number.isFinite(value))) return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor > 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? minor : null;
}

export function getVariantPrice(product, variant) {
  if (!variant) return null;
  // Igual que computeTotalsCRC: cero, negativos y texto malformado NO heredan.
  const raw = variant.price === undefined || variant.price === null || variant.price === ''
    ? product?.basePrice : variant.price;
  const minor = priceMinor(raw);
  if (minor === null) return null;
  const amount = Number(`${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`);
  return priceMinor(amount) === minor ? amount : null;
}

export function isActiveVariant(variant) {
  return Boolean(variant && variant.active !== false && !variant.deleted);
}

export function getCatalogPriceSummary(product, variants = []) {
  const activeVariants = variants.filter(isActiveVariant);
  const options = activeVariants
    .map(variant => ({ variant, price: getVariantPrice(product, variant) }))
    .filter(option => option.price !== null)
    .sort((a, b) => {
      const difference = a.price - b.price || ((a.variant.order || 0) - (b.variant.order || 0));
      if (difference) return difference;
      const aId = String(a.variant.id || '');
      const bId = String(b.variant.id || '');
      return aId === bId ? 0 : aId < bId ? -1 : 1;
    });
  const minimum = options[0];
  const maximum = options.at(-1);
  return {
    // Conserva el precio de referencia de un producto sin variantes activas.
    // No permite que una variante activa con un precio inválido use ese atajo.
    price: minimum?.price ?? (activeVariants.length === 0 ? getVariantPrice(product, {}) : null),
    isFrom: Boolean(minimum && minimum.price !== maximum.price),
    mainVariant: minimum?.variant ?? null,
  };
}
