// Regla de "Bajo pedido" (decisión de Carlos), igual que src/utils/backorder.js:
//   - Líneas en stock y envío: se pagan completos.
//   - Líneas "Bajo pedido": se aparta con el 25% de su monto; el 75% restante es el saldo.
const BACKORDER_DEPOSIT_PERCENT = 0.25;

/**
 * @param {Array<{supplyType:string, lineTotal:number}>} lines
 * @param {number} shippingCost
 * @returns {{hasBackorder:boolean,total:number,backorderSubtotal:number,depositTotal:number,balanceDue:number,payNowTotal:number,depositByLine:number[]}}
 * El anticipo se reparte entre las líneas bajo pedido en proporción a su monto
 * (el redondeo sobrante va a la última), de modo que la suma por línea = depositTotal.
 */
function computeBackorder(lines, shippingCost = 0) {
  const amount = (l) => Number(l.lineTotal) || 0;
  const subtotal = lines.reduce((sum, l) => sum + amount(l), 0);
  const total = subtotal + (Number(shippingCost) || 0);
  const idx = lines.map((l, i) => (l.supplyType === "bajo_pedido" ? i : -1)).filter((i) => i >= 0);
  const depositByLine = lines.map(() => 0);
  if (!idx.length) return { hasBackorder: false, total, backorderSubtotal: 0, depositTotal: 0, balanceDue: 0, payNowTotal: total, depositByLine };
  const backorderSubtotal = idx.reduce((sum, i) => sum + amount(lines[i]), 0);
  const depositTotal = Math.round(backorderSubtotal * BACKORDER_DEPOSIT_PERCENT);
  let assigned = 0;
  idx.forEach((i, n) => {
    const share = n === idx.length - 1 ? depositTotal - assigned
      : (backorderSubtotal > 0 ? Math.round(depositTotal * amount(lines[i]) / backorderSubtotal) : 0);
    depositByLine[i] = share;
    assigned += share;
  });
  const balanceDue = backorderSubtotal - depositTotal;
  return { hasBackorder: true, total, backorderSubtotal, depositTotal, balanceDue, payNowTotal: total - balanceDue, depositByLine };
}

module.exports = { computeBackorder, BACKORDER_DEPOSIT_PERCENT };
