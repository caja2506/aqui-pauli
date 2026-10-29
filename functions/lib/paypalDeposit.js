// PayPal cobra el mismo "a pagar ahora" que SINPE. Estos importes se obtienen
// exclusivamente de líneas del catálogo calculadas por el servidor.
const { createHash } = require("node:crypto");
const { computeBackorder, BACKORDER_DEPOSIT_PERCENT } = require("./backorderDeposit");
const { crcToUsd } = require("./fx");

const QUOTE_FIELDS = ["crcSubtotal", "crcShipping", "crcTotal", "crcPayNow", "crcBalanceDue",
  "crcBackorderSubtotal", "crcDepositTotal", "usdTotal", "fxRate", "fxBufferPct", "depositPercent"];

function paymentQuote(totals, fx) {
  const backorder = computeBackorder(totals.lines, totals.shippingCost);
  if (!Number.isFinite(backorder.payNowTotal) || backorder.payNowTotal <= 0) {
    throw new Error("El monto a pagar ahora debe ser mayor que cero");
  }
  return {
    crcSubtotal: totals.subtotal, crcShipping: totals.shippingCost, crcTotal: totals.total,
    crcPayNow: backorder.payNowTotal, crcBalanceDue: backorder.balanceDue,
    crcBackorderSubtotal: backorder.backorderSubtotal, crcDepositTotal: backorder.depositTotal,
    hasBackorder: backorder.hasBackorder, depositPercent: BACKORDER_DEPOSIT_PERCENT,
    usdTotal: Number(crcToUsd(backorder.payNowTotal, fx.rate, fx.bufferPct)),
    fxRate: fx.rate, fxSource: fx.source || "", fxDate: fx.date || "",
    fxBufferPct: fx.bufferPct || 0, currency: "USD",
  };
}

// La cotización enviada por React es solo una afirmación de lo mostrado, nunca
// una fuente de importes. La comparación evita aprobar un monto que cambió.
function quoteMatches(expected, actual) {
  return !!expected && expected.currency === actual.currency
    && expected.hasBackorder === actual.hasBackorder
    && QUOTE_FIELDS.every((key) => typeof expected[key] === "number"
      && Number.isFinite(expected[key]) && expected[key] === actual[key]);
}

function quoteFromAttempt(attempt) {
  return Object.fromEntries([...QUOTE_FIELDS, "hasBackorder", "currency", "fxSource", "fxDate"]
    .map((key) => [key, attempt[key]]));
}

function snapshotKey(totals) {
  const lines = totals.lines.map((line) => [line.productId, line.variantId, line.quantity,
    line.unitPrice, line.lineTotal, line.supplyType, line.itemId || null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify([lines, totals.subtotal, totals.shippingCost, totals.total])).digest("hex");
}

function initialPaymentReceived(order) {
  return ["pagado", "verificado", "parcial"].includes(order?.paymentStatus)
    || order?.paypal?.captureStatus === "COMPLETED";
}

module.exports = { paymentQuote, quoteMatches, quoteFromAttempt, snapshotKey, initialPaymentReceived };
