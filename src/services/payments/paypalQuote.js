// A displayed PayPal quote is only a comparison value. The server calculates
// and validates the amount again before it creates a provider order.
const FIELDS = ['crcTotal', 'crcPayNow', 'crcBalanceDue', 'crcBackorderSubtotal',
  'crcDepositTotal', 'hasBackorder', 'depositPercent', 'usdTotal', 'fxRate', 'fxBufferPct', 'currency'];

export function paypalQuoteKey(items, canton, shippingType) {
  return JSON.stringify([items.map(({ productId, variantId, quantity }) => [productId, variantId, quantity]), canton, shippingType]);
}

export function isPayablePaypalQuote(quote) {
  return !!quote && quote.currency === 'USD' && quote.depositPercent === 0.5
    && typeof quote.hasBackorder === 'boolean'
    && ['crcTotal', 'crcPayNow', 'crcBalanceDue', 'crcBackorderSubtotal', 'crcDepositTotal', 'usdTotal', 'fxRate', 'fxBufferPct']
      .every((field) => typeof quote[field] === 'number' && Number.isFinite(quote[field]) && quote[field] >= 0)
    && quote.usdTotal > 0 && quote.fxRate > 0 && quote.crcPayNow > 0
    && Math.abs(quote.crcTotal - quote.crcPayNow - quote.crcBalanceDue) < 0.005;
}

export function samePaypalQuote(left, right) {
  return isPayablePaypalQuote(left) && isPayablePaypalQuote(right)
    && FIELDS.every((field) => left[field] === right[field]);
}

export function backorderFromPaypalQuote(quote) {
  if (!isPayablePaypalQuote(quote)) return null;
  return {
    hasBackorder: quote.hasBackorder, total: quote.crcTotal,
    backorderSubtotal: quote.crcBackorderSubtotal, depositTotal: quote.crcDepositTotal,
    balanceDue: quote.crcBalanceDue, payNowTotal: quote.crcPayNow,
  };
}
