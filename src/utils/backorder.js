// Regla de "Bajo pedido" (decisión de Carlos):
//   - Las líneas en stock se pagan completas, igual que el envío.
//   - Las líneas "Bajo pedido" se aparta con el 50% de SU monto (solo esas líneas).
//   - El 50% restante de esas líneas es el saldo, que se paga después.
// Misma regla en functions/lib/backorderDeposit.js (hay una prueba de paridad en functions/test).
export const BACKORDER_DEPOSIT_PERCENT = 0.5;
export const BACKORDER_DEPOSIT_LABEL = `${BACKORDER_DEPOSIT_PERCENT * 100}%`;
export const BACKORDER_BALANCE_TIMING = 'cuando tu pedido esté listo para entregarse; te avisamos por WhatsApp antes de despacharlo';

/**
 * @param {Array<{supplyType?:string, lineTotal?:number, price?:number, quantity?:number}>} lines
 * @param {number} shippingCost
 */
export function computeBackorder(lines = [], shippingCost = 0) {
  const lineTotal = (l) => Number(l.lineTotal ?? (Number(l.price) || 0) * (Number(l.quantity) || 0)) || 0;
  const isBackorder = (l) => l.supplyType === 'bajo_pedido';
  const subtotal = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  const total = subtotal + (Number(shippingCost) || 0);
  const backorderSubtotal = lines.filter(isBackorder).reduce((sum, l) => sum + lineTotal(l), 0);
  const hasBackorder = lines.some(isBackorder);
  if (!hasBackorder) {
    return { hasBackorder: false, total, backorderSubtotal: 0, depositTotal: 0, balanceDue: 0, payNowTotal: total };
  }
  const depositTotal = Math.round(backorderSubtotal * BACKORDER_DEPOSIT_PERCENT);
  const balanceDue = backorderSubtotal - depositTotal;
  return { hasBackorder: true, total, backorderSubtotal, depositTotal, balanceDue, payNowTotal: total - balanceDue };
}
