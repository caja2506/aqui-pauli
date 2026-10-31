// Displayed amounts are comparison values. Only the server prices and charges
// the order; a local cart price must never enable a card payment.
const AMOUNTS = ['crcTotal', 'crcSubtotal', 'crcShipping', 'crcPayNow',
  'crcBalanceDue', 'crcDepositTotal', 'crcBackorderSubtotal'];
const FIELDS = ['currency', 'hasBackorder', ...AMOUNTS];
const equalMoney = (left, right) => Math.abs(left - right) < 0.005;

export function tilopayQuoteKey(items, canton, shippingType) {
  return JSON.stringify([(Array.isArray(items) ? items : []).map(({ productId, variantId, quantity }) =>
    [String(productId ?? ''), String(variantId ?? ''), Number(quantity)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  canton || '', shippingType || 'normal']);
}

export function isPayableTilopayQuote(quote) {
  return !!quote && quote.currency === 'CRC' && typeof quote.hasBackorder === 'boolean'
    && AMOUNTS.every(field => typeof quote[field] === 'number' && Number.isFinite(quote[field]) && quote[field] >= 0)
    && quote.crcPayNow > 0 && quote.crcBackorderSubtotal <= quote.crcSubtotal
    && quote.crcDepositTotal <= quote.crcBackorderSubtotal
    && (!quote.hasBackorder ? quote.crcBackorderSubtotal === 0 && quote.crcDepositTotal === 0 : true)
    && equalMoney(quote.crcSubtotal + quote.crcShipping, quote.crcTotal)
    && equalMoney(quote.crcTotal, quote.crcPayNow + quote.crcBalanceDue)
    // Historical attempts charged the complete order even when it contained
    // backorders. Their immutable quote has neither deposit nor balance.
    && (equalMoney(quote.crcBackorderSubtotal - quote.crcDepositTotal, quote.crcBalanceDue)
      || (quote.crcDepositTotal === 0 && quote.crcBalanceDue === 0 && equalMoney(quote.crcPayNow, quote.crcTotal)));
}

export function sameTilopayQuote(left, right) {
  return isPayableTilopayQuote(left) && isPayableTilopayQuote(right)
    && FIELDS.every(field => left[field] === right[field]);
}

export function tilopayQuoteAmounts(value) {
  return isPayableTilopayQuote(value) ? Object.fromEntries(FIELDS.map(field => [field, value[field]])) : null;
}

export function backorderFromTilopayQuote(quote) {
  if (!isPayableTilopayQuote(quote)) return null;
  return { hasBackorder: quote.hasBackorder, total: quote.crcTotal,
    backorderSubtotal: quote.crcBackorderSubtotal, depositTotal: quote.crcDepositTotal,
    payNowTotal: quote.crcPayNow, balanceDue: quote.crcBalanceDue };
}
