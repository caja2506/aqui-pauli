"use strict";

const { computeBackorder, BACKORDER_DEPOSIT_PERCENT } = require("./backorderDeposit");
const { parseMinorCRC, minorToCRC } = require("./paymentMoney");

function minor(value, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new Error("Importe del plan de pago inválido.");
  }
  return value;
}

function sum(values) { return minor(values.reduce((total, value) => total + minor(value), 0)); }

// Version 1 is a frozen policy: 50% of backorder merchandise, rounded to whole
// colones, with proportional cumulative allocation. A future business-policy
// change must use another plan version, never reinterpret an existing charge.
function frozenPlanV1(lines, totalMinor) {
  const backorder = lines.filter((line) => line.supplyType === "bajo_pedido");
  const backorderSubtotalMinor = sum(backorder.map((line) => line.lineTotalMinor));
  const depositMinor = Number(((BigInt(backorderSubtotalMinor) + 100n) / 200n) * 100n);
  if (backorder.length && (depositMinor <= 0 || depositMinor > backorderSubtotalMinor)) {
    throw new Error("El importe bajo pedido no permite calcular un apartado válido.");
  }
  let accumulated = 0n;
  let assigned = 0;
  const depositByItem = lines.map((line) => {
    let amountMinor = 0;
    if (line.supplyType === "bajo_pedido") {
      accumulated += BigInt(line.lineTotalMinor);
      const numerator = BigInt(depositMinor / 100) * accumulated;
      const denominator = BigInt(backorderSubtotalMinor);
      const cumulative = Number(((2n * numerator + denominator) / (2n * denominator)) * 100n);
      amountMinor = cumulative - assigned;
      assigned = cumulative;
      if (amountMinor < 0 || amountMinor > line.lineTotalMinor) {
        throw new Error("No se puede distribuir el apartado entre los productos.");
      }
    }
    return { itemId: line.itemId, amountMinor };
  });
  const remainingMinor = backorderSubtotalMinor - depositMinor;
  const amountMinor = minor(totalMinor - remainingMinor, { positive: true });
  return { version: 1, depositPercent: 50, hasBackorder: backorder.length > 0,
    backorderSubtotalMinor, depositMinor, remainingMinor, amountMinor, depositByItem };
}

function makePaymentPlan(lines, totalMinor, shippingMinor) {
  const plan = frozenPlanV1(lines, totalMinor);
  const shared = computeBackorder(lines, minorToCRC(shippingMinor));
  // New attempts follow the same calculator as SINPE/PayPal. Reject an
  // unsupported policy/rounding change instead of silently charging differently.
  if (BACKORDER_DEPOSIT_PERCENT !== 0.5 || shared.hasBackorder !== plan.hasBackorder
    || parseMinorCRC(shared.depositTotal, { allowZero: true }) !== plan.depositMinor
    || shared.depositByLine.some((amount, index) =>
      parseMinorCRC(amount, { allowZero: true }) !== plan.depositByItem[index].amountMinor)) {
    throw new Error("La política de apartado requiere actualizar la versión del plan Tilopay.");
  }
  return plan;
}

function validateSnapshotAmounts(snapshot) {
  if (!snapshot || ![1, 2].includes(snapshot.version) || snapshot.currency !== "CRC"
    || !Array.isArray(snapshot.lines) || !snapshot.lines.length || snapshot.lines.length > 50) {
    throw new Error("Snapshot de pago inválido.");
  }
  const { lines } = snapshot;
  const ids = new Set();
  for (const line of lines) {
    if (typeof line.itemId !== "string" || !line.itemId || ids.has(line.itemId)
      || !["stock_propio", "bajo_pedido"].includes(line.supplyType)
      || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 99
      || minor(line.unitPriceMinor, { positive: true }) * line.quantity !== minor(line.lineTotalMinor, { positive: true })
      || parseMinorCRC(line.unitPrice) !== line.unitPriceMinor
      || parseMinorCRC(line.lineTotal) !== line.lineTotalMinor) {
      throw new Error("Línea del snapshot de pago inválida.");
    }
    ids.add(line.itemId);
  }
  const subtotalMinor = minor(snapshot.subtotalMinor, { positive: true });
  const shippingMinor = minor(snapshot.shippingMinor);
  const totalMinor = sum([subtotalMinor, shippingMinor]);
  const amountMinor = minor(snapshot.amountMinor, { positive: true });
  if (sum(lines.map((line) => line.lineTotalMinor)) !== subtotalMinor) {
    throw new Error("Subtotal del snapshot inconsistente.");
  }
  if (snapshot.version === 1) {
    if (amountMinor !== totalMinor) throw new Error("Importe histórico del snapshot inconsistente.");
    return { totalMinor, amountMinor, remainingMinor: 0, depositMinor: 0,
      backorderSubtotalMinor: sum(lines.filter((line) => line.supplyType === "bajo_pedido").map((line) => line.lineTotalMinor)),
      hasBackorder: lines.some((line) => line.supplyType === "bajo_pedido"), depositByItem: [] };
  }
  const plan = snapshot.paymentPlan;
  if (!plan || plan.version !== 1 || plan.depositPercent !== 50 || snapshot.totalMinor !== totalMinor) {
    throw new Error("Versión o total del plan de pago inválido.");
  }
  const expected = frozenPlanV1(lines, totalMinor);
  for (const key of ["hasBackorder", "backorderSubtotalMinor", "depositMinor", "remainingMinor", "amountMinor"]) {
    if (plan[key] !== expected[key]) throw new Error("Plan de pago inconsistente.");
  }
  if (amountMinor !== plan.amountMinor || !Array.isArray(plan.depositByItem)
    || plan.depositByItem.length !== expected.depositByItem.length
    || plan.depositByItem.some((line, index) => line.itemId !== expected.depositByItem[index].itemId
      || line.amountMinor !== expected.depositByItem[index].amountMinor)) {
    throw new Error("Distribución del apartado inconsistente.");
  }
  return { totalMinor, amountMinor, remainingMinor: plan.remainingMinor, depositMinor: plan.depositMinor,
    backorderSubtotalMinor: plan.backorderSubtotalMinor, hasBackorder: plan.hasBackorder,
    depositByItem: plan.depositByItem.map((line) => ({ ...line })) };
}

function quoteFromSnapshot(snapshot) {
  const amounts = validateSnapshotAmounts(snapshot);
  return { currency: "CRC", crcTotal: minorToCRC(amounts.totalMinor),
    crcSubtotal: minorToCRC(snapshot.subtotalMinor), crcShipping: minorToCRC(snapshot.shippingMinor),
    crcPayNow: minorToCRC(amounts.amountMinor), crcBalanceDue: minorToCRC(amounts.remainingMinor),
    crcDepositTotal: minorToCRC(amounts.depositMinor), crcBackorderSubtotal: minorToCRC(amounts.backorderSubtotalMinor),
    hasBackorder: amounts.hasBackorder };
}

module.exports = { makePaymentPlan, validateSnapshotAmounts, quoteFromSnapshot };
