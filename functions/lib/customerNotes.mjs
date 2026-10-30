// Contrato compartido por checkout, pedidos manuales y creación en el servidor.
export const MAX_CUSTOMER_NOTES_LENGTH = 1000;

export function normalizeCustomerNotes(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('Las notas del pedido deben ser texto.');
  const notes = value.trim();
  if (notes.length > MAX_CUSTOMER_NOTES_LENGTH) {
    throw new Error(`Las notas del pedido pueden tener hasta ${MAX_CUSTOMER_NOTES_LENGTH} caracteres.`);
  }
  return notes;
}
