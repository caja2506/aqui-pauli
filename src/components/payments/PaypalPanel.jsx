import { useEffect, useRef, useState } from 'react';
import { formatCRC } from '../../utils/formatters';
import { BACKORDER_BALANCE_TIMING, BACKORDER_DEPOSIT_LABEL } from '../../utils/backorder';
import { loadPaypalSdk, paypalCaptureOrder, paypalCreateOrder, paypalGetConfig, paypalGetQuote } from '../../services/payments/paypalClient';
import { isPayablePaypalQuote, paypalQuoteKey, samePaypalQuote } from '../../services/payments/paypalQuote';

const fmtUsd = (n) => `US$ ${Number(n).toFixed(2)}`;
const CHANGED_QUOTE = 'El importe o el tipo de cambio cambió. Revisá la cotización actualizada y volvé a pulsar PayPal para aprobarla.';

/** The visible quote and the provider order charge only the server's due-now amount. */
export default function PaypalPanel({ items, canton, shippingType, validateForm, createPendingOrder, onPaid, onQuote }) {
  const [cfg, setCfg] = useState(null);
  const [quoted, setQuoted] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [message, setMessage] = useState('');
  const [sdkError, setSdkError] = useState('');
  const [captureRecovery, setCaptureRecovery] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const container = useRef(null);
  const pendingRef = useRef(null);
  const flowError = useRef('');
  const latest = useRef({});
  const unresolvedCapture = useRef(null);
  const captureInFlight = useRef(false);
  const quoteKey = paypalQuoteKey(items, canton, shippingType);
  const quote = quoted?.key === quoteKey && isPayablePaypalQuote(quoted.quote) ? quoted.quote : null;
  latest.current = { validateForm, createPendingOrder, onPaid, onQuote, quote, quoteKey, items, canton, shippingType, confirmPayment };

  async function confirmPayment(pending) {
    if (captureInFlight.current) return;
    captureInFlight.current = true;
    unresolvedCapture.current = pending;
    setCaptureRecovery(pending);
    setConfirming(true);
    setMessage('Confirmando tu pago…');
    try {
      const result = await paypalCaptureOrder({ orderId: pending.orderId, paypalOrderId: pending.paypalOrderId });
      if (['captured', 'already_paid', 'pending'].includes(result.result)) {
        unresolvedCapture.current = null;
        setCaptureRecovery(null);
        latest.current.onPaid({ ...pending, paypalResult: result.result, partial: result.partial });
      } else if (result.result === 'declined') {
        unresolvedCapture.current = null;
        setCaptureRecovery(null);
        setMessage(result.message || 'El pago fue rechazado. Podés intentar nuevamente.');
      } else {
        throw new Error('Respuesta de pago no reconocida.');
      }
    } catch {
      flowError.current = 'No pudimos confirmar la respuesta del pago. Puede haberse cobrado: usá «Revisar este pago» antes de intentar otro pago.';
      setMessage(flowError.current);
    } finally {
      captureInFlight.current = false;
      setConfirming(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    paypalGetConfig().then((value) => { if (!cancelled) setCfg(value); })
      .catch(() => { if (!cancelled) setSdkError('PayPal no está disponible por ahora.'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setQuoted(null);
    setQuoteError('');
    latest.current.onQuote?.({ key: quoteKey, quote: null });
    if (!canton) return undefined;
    const t = setTimeout(() => {
      paypalGetQuote({
        items: items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
        canton, shippingType,
      }).then((value) => {
        if (!isPayablePaypalQuote(value)) throw new Error('No se pudo confirmar el importe a pagar. Volvé a cargar la cotización.');
        if (!cancelled) {
          setQuoted({ key: quoteKey, quote: value });
          latest.current.onQuote?.({ key: quoteKey, quote: value });
        }
      }).catch((error) => { if (!cancelled) setQuoteError(error?.message || 'No se pudo calcular el importe en dólares.'); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // The key includes every product id, variant, quantity and shipping choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey]);

  const quoteReady = !!quote && !quoteError && cfg?.enabled !== false && !captureRecovery;
  useEffect(() => {
    if (!cfg?.clientId || !quoteReady || !container.current) return undefined;
    let buttons;
    let disposed = false;
    loadPaypalSdk(cfg.clientId).then((paypal) => {
      if (disposed || !container.current) return;
      buttons = paypal.Buttons({
        style: { layout: 'vertical', shape: 'pill', label: 'pay' },
        onClick: (_data, actions) => {
          if (unresolvedCapture.current) return actions.reject();
          flowError.current = '';
          setMessage('');
          if (!latest.current.quote || latest.current.quoteKey !== quoteKey) {
            setMessage('Esperá a que se confirme el importe a pagar.');
            return actions.reject();
          }
          if (!latest.current.validateForm()) {
            setMessage('Completá los datos de contacto y envío antes de pagar.');
            return actions.reject();
          }
          return actions.resolve();
        },
        createOrder: async () => {
          if (unresolvedCapture.current) throw new Error('Revisá el pago anterior antes de crear otro intento.');
          const current = latest.current;
          const expectedQuote = current.quote;
          if (!expectedQuote || current.quoteKey !== quoteKey) throw new Error('La cotización ya no está vigente.');
          const pending = await current.createPendingOrder('paypal');
          if (latest.current.quoteKey !== quoteKey || !samePaypalQuote(expectedQuote, latest.current.quote)) {
            flowError.current = CHANGED_QUOTE;
            setMessage(CHANGED_QUOTE);
            throw new Error(CHANGED_QUOTE);
          }
          try {
            const result = await paypalCreateOrder({ orderId: pending.orderId, expectedQuote });
            if (latest.current.quoteKey !== quoteKey || !samePaypalQuote(expectedQuote, result)) {
              flowError.current = CHANGED_QUOTE;
              setMessage(CHANGED_QUOTE);
              throw Object.assign(new Error(CHANGED_QUOTE), { quoteMismatch: true,
                details: { quote: isPayablePaypalQuote(result) ? result : null } });
            }
            pendingRef.current = { ...pending, paypalOrderId: result.paypalOrderId, paypalQuote: result };
            return result.paypalOrderId;
          } catch (error) {
            const savedQuote = error?.details?.quote;
            if (isPayablePaypalQuote(savedQuote) || error?.quoteMismatch) {
              flowError.current = CHANGED_QUOTE;
              setMessage(CHANGED_QUOTE);
              if (latest.current.quoteKey === quoteKey) {
                setQuoted(null);
                latest.current.onQuote?.({ key: quoteKey, quote: null });
                try {
                  // A saved provider attempt keeps its own prices/FX. Reusing
                  // that server quote avoids a loop against a newer catalog FX.
                  const refreshed = isPayablePaypalQuote(savedQuote) ? savedQuote : await paypalGetQuote({
                    items: current.items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
                    canton: current.canton, shippingType: current.shippingType,
                  });
                  if (!isPayablePaypalQuote(refreshed)) throw new Error('Cotización no disponible.');
                  if (latest.current.quoteKey === quoteKey) {
                    setQuoted({ key: quoteKey, quote: refreshed });
                    latest.current.onQuote?.({ key: quoteKey, quote: refreshed });
                    setQuoteError('');
                  }
                } catch {
                  setQuoteError('No se pudo actualizar la cotización. Recargá la página antes de intentar pagar.');
                }
              }
            } else if (error?.code === 'functions/failed-precondition') {
              // An already-paid, expired or changed-reservation order needs
              // the specific server instruction, not another quote retry.
              flowError.current = error.message || 'Este pedido requiere revisión antes de intentar otro pago.';
              setMessage(flowError.current);
              setQuoteError(flowError.current);
            }
            throw error;
          }
        },
        onApprove: async (data) => {
          const pending = pendingRef.current;
          if (!pending || pending.paypalOrderId !== data?.orderID) {
            setMessage('No se pudo identificar este intento de pago. Recargá la página para revisar tu pedido.');
            return;
          }
          await latest.current.confirmPayment(pending);
        },
        onCancel: () => setMessage('Cancelaste el pago. Podés intentarlo de nuevo cuando quieras.'),
        onError: (error) => {
          console.error('PayPal error:', error);
          setMessage(flowError.current || 'PayPal tuvo un problema. Intentá de nuevo o elegí otro método.');
        },
      });
      buttons.render(container.current);
    }).catch((error) => { if (!disposed) setSdkError(error.message); });
    return () => { disposed = true; try { buttons?.close(); } catch { /* already closed */ } };
  }, [cfg?.clientId, quoteReady, quoteKey]);

  const isDeposit = !!quote?.hasBackorder && quote.crcBalanceDue > 0;
  return (
    <div className="p-4 bg-sky-50 rounded-xl border border-sky-200 space-y-3">
      <p className="text-xs font-bold text-sky-800">Pago con PayPal o tarjeta (cobro en dólares)</p>
      {cfg?.env === 'sandbox' && (
        <p className="text-[10px] font-bold text-amber-700 bg-amber-100 rounded-lg px-2 py-1">
          MODO PRUEBAS (sandbox) — no se cobra dinero real
        </p>
      )}
      {!canton ? (
        <p className="text-xs text-slate-500">Seleccioná tu cantón para confirmar el importe a pagar.</p>
      ) : quoteError ? (
        <p className="text-xs text-red-600" role="alert">{quoteError}</p>
      ) : quote ? (
        <div className="text-sm text-slate-800 space-y-1" data-testid="paypal-quote">
          <p className="font-black text-sky-900">Pagás ahora {formatCRC(quote.crcPayNow)}{isDeposit ? ` (apartado ${BACKORDER_DEPOSIT_LABEL})` : ''}</p>
          <p>Cobro de hoy en PayPal: <span className="font-black">{fmtUsd(quote.usdTotal)}</span></p>
          {isDeposit && <>
            <p>Incluye el {BACKORDER_DEPOSIT_LABEL} de los productos Bajo pedido, más los productos en stock y el envío completos.</p>
            <p>Total del pedido: <strong>{formatCRC(quote.crcTotal)}</strong> · Saldo pendiente: <strong>{formatCRC(quote.crcBalanceDue)}</strong></p>
            <p className="text-xs">El saldo se paga {BACKORDER_BALANCE_TIMING}.</p>
          </>}
          <p className="text-[11px] text-slate-500">
            {formatCRC(quote.crcPayNow)} al tipo de cambio ₡{Number(quote.fxRate).toFixed(2)} por US$1
            {quote.fxDate ? ` (${quote.fxDate})` : ''}{quote.fxBufferPct > 0 ? ` · ajuste de conversión ${quote.fxBufferPct}%` : ''}. PayPal cobra en USD; tu banco puede aplicar su propio tipo de cambio.
          </p>
        </div>
      ) : (
        <p className="text-xs text-slate-400">Calculando el importe a pagar en el servidor…</p>
      )}
      {sdkError ? <p className="text-xs text-red-600">{sdkError}</p>
        : cfg?.enabled === false ? <p className="text-xs text-red-600">PayPal no está disponible por ahora.</p>
        : quoteReady ? <div ref={container} className="min-h-[50px]" /> : null}
      {captureRecovery && (
        <div className="space-y-2" data-testid="paypal-capture-recovery">
          <p className="text-xs text-sky-900">Verificá el pago de {formatCRC(captureRecovery.paypalQuote.crcPayNow)} para el pedido {captureRecovery.orderNumber}.</p>
          <button type="button" disabled={confirming} onClick={() => confirmPayment(captureRecovery)}
            className="w-full rounded-xl bg-sky-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">
            {confirming ? 'Confirmando tu pago…' : 'Revisar este pago'}
          </button>
        </div>
      )}
      {message && <p className="text-xs font-bold text-slate-700" role="status">{message}</p>}
    </div>
  );
}
