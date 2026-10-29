// Frases antiguas en las descripciones de producto que prometen algo que el checkout no cumple
// (el envío se cobra y no hay pago contra entrega).
const OLD_PROMISE_RE = /env[ií]o\s+(?:incluido|gratis|gratuito)(?:\s+(?:a|en)\s+todo\s+(?:el\s+)?pa[ií]s)?(?:\s*(?:y|e|,|\+|\/)\s*(?:pago\s+)?(?:contra\s*entrega|contraentrega))?|(?:pago\s+)?contra\s*-?\s*entrega/gi;

export const SHIPPING_NOTE = 'Envío incluido a todo el país. Elegís el método de pago al finalizar la compra.';

// Reemplaza la promesa vieja por el texto correcto (una sola vez por descripción)
export function cleanShippingPromise(text, note = SHIPPING_NOTE) {
  if (!text) return text;
  let used = false;
  const out = text.replace(OLD_PROMISE_RE, () => (used ? '' : ((used = true), note)));
  return out.replace(/\s*·\s*·\s*/g, ' · ').replace(/\s*·\s*$/, '').replace(/\.\s*\./g, '.').trim();
}
