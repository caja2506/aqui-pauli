// Anticipo "Bajo pedido": 20% del TOTAL del pedido (productos + envío) si alguna línea es bajo pedido.
// Misma regla que el checkout del navegador (src/services/orderService.js).
const BACKORDER_DEPOSIT_PERCENT = 0.20;

/**
 * @param {Array<{supplyType:string, lineTotal:number}>} lines
 * @param {number} orderTotal total del pedido en colones
 * @returns {{hasBackorder:boolean, depositTotal:number, depositByLine:number[]}}
 * El anticipo del pedido se reparte entre las líneas bajo pedido en proporción a su monto
 * (el redondeo sobrante va a la última), de modo que la suma de líneas = depositTotal.
 */
function computeBackorderDeposit(lines, orderTotal) {
  const backorderIdx = lines.map((l, i) => (l.supplyType === "bajo_pedido" ? i : -1)).filter((i) => i >= 0);
  const depositByLine = lines.map(() => 0);
  if (!backorderIdx.length) return { hasBackorder: false, depositTotal: 0, depositByLine };
  const depositTotal = Math.round((Number(orderTotal) || 0) * BACKORDER_DEPOSIT_PERCENT);
  const base = backorderIdx.reduce((sum, i) => sum + (Number(lines[i].lineTotal) || 0), 0);
  let assigned = 0;
  backorderIdx.forEach((i, n) => {
    const isLast = n === backorderIdx.length - 1;
    const share = isLast ? depositTotal - assigned
      : (base > 0 ? Math.round(depositTotal * (Number(lines[i].lineTotal) || 0) / base) : 0);
    depositByLine[i] = share;
    assigned += share;
  });
  return { hasBackorder: true, depositTotal, depositByLine };
}

module.exports = { computeBackorderDeposit, BACKORDER_DEPOSIT_PERCENT };
