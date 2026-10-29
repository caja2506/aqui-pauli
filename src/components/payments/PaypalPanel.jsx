import { useEffect, useRef, useState } from 'react';
import { formatCRC } from '../../utils/formatters';
import { loadPaypalSdk, paypalCaptureOrder, paypalCreateOrder, paypalGetConfig, paypalGetQuote } from '../../services/payments/paypalClient';

const fmtUsd = (n) => `US$ ${Number(n).toFixed(2)}`;

/**
 * Panel de PayPal para el checkout. Muestra el total en USD y el tipo de cambio
 * ANTES de pagar y renderiza los botones del JS SDK (PayPal + tarjeta).
 * El monto real lo calcula el servidor (paypalCreateOrder).
 */
export default function PaypalPanel({ items, canton, shippingType, totalCRC, validateForm, createPendingOrder, onPaid }) {
  const [cfg, setCfg] = useState(null);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [message, setMessage] = useState('');
  const [sdkError, setSdkError] = useState('');
  const container = useRef(null);
  const pendingRef = useRef(null);
  const latest = useRef({});
  latest.current = { validateForm, createPendingOrder, onPaid, canReady: !!canton };

  // Config pública (clientId / entorno)
  useEffect(() => { paypalGetConfig().then(setCfg).catch(() => setSdkError('PayPal no está disponible por ahora.')); }, []);

  // Cotización en USD (servidor) cada vez que cambia el carrito o el envío
  const itemsKey = JSON.stringify(items.map(i => [i.productId, i.variantId, i.quantity]));
  useEffect(() => {
    if (!canton) { setQuote(null); setQuoteError(''); return undefined; }
    let cancelled = false;
    const t = setTimeout(() => {
      paypalGetQuote({
        items: items.map(i => ({ productId: i.productId, variantId: i.variantId, quantity: i.quantity })),
        canton, shippingType,
      }).then(q => { if (!cancelled) { setQuote(q); setQuoteError(''); } })
        .catch(e => { if (!cancelled) setQuoteError(e?.message || 'No se pudo calcular el total en USD.'); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, canton, shippingType]);

  // Botones PayPal
  useEffect(() => {
    if (!cfg?.clientId || !container.current) return undefined;
    let buttons;
    let disposed = false;
    loadPaypalSdk(cfg.clientId).then((paypal) => {
      if (disposed || !container.current) return;
      buttons = paypal.Buttons({
        style: { layout: 'vertical', shape: 'pill', label: 'pay' },
        onClick: (_data, actions) => {
          setMessage('');
          if (!latest.current.validateForm()) {
            setMessage('Completa los datos de contacto y envío antes de pagar.');
            return actions.reject();
          }
          return actions.resolve();
        },
        createOrder: async () => {
          const pending = await latest.current.createPendingOrder('paypal');
          pendingRef.current = pending;
          const res = await paypalCreateOrder({ orderId: pending.orderId });
          setQuote(res);
          return res.paypalOrderId;
        },
        onApprove: async (data) => {
          setMessage('Confirmando tu pago…');
          const pending = pendingRef.current;
          const res = await paypalCaptureOrder({ orderId: pending.orderId, paypalOrderId: data.orderID });
          if (res.result === 'captured' || res.result === 'already_paid' || res.result === 'pending') {
            latest.current.onPaid({ ...pending, paypalResult: res.result });
          } else {
            setMessage(res.message || 'El pago no se completó. Intenta de nuevo.');
          }
        },
        onCancel: () => setMessage('Cancelaste el pago. Puedes intentarlo de nuevo cuando quieras.'),
        onError: (err) => {
          console.error('PayPal error:', err);
          setMessage('PayPal tuvo un problema. Intenta de nuevo o elige otro método.');
        },
      });
      buttons.render(container.current);
    }).catch((e) => setSdkError(e.message));
    return () => { disposed = true; try { buttons?.close(); } catch { /* ya cerrado */ } };
  }, [cfg?.clientId]);

  return (
    <div className="p-4 bg-sky-50 rounded-xl border border-sky-200 space-y-3">
      <p className="text-xs font-bold text-sky-800">Pago con PayPal o tarjeta (cobro en dólares)</p>
      {cfg?.env === 'sandbox' && (
        <p className="text-[10px] font-bold text-amber-700 bg-amber-100 rounded-lg px-2 py-1">
          MODO PRUEBAS (sandbox) — no se cobra dinero real
        </p>
      )}
      {!canton ? (
        <p className="text-xs text-slate-500">Selecciona tu cantón para calcular el total en dólares.</p>
      ) : quote ? (
        <div className="text-sm text-slate-800 space-y-0.5">
          <p>Total a pagar: <span className="font-black">{fmtUsd(quote.usdTotal)}</span></p>
          <p className="text-[11px] text-slate-500">
            {formatCRC(quote.crcTotal)} al tipo de cambio ₡{Number(quote.fxRate).toFixed(2)} por US$1
            {quote.fxDate ? ` (${quote.fxDate})` : ''} · BCCR vía Hacienda. PayPal cobra en USD; tu banco puede aplicar su propio tipo de cambio.
          </p>
        </div>
      ) : quoteError ? (
        <p className="text-xs text-red-600">{quoteError}</p>
      ) : (
        <p className="text-xs text-slate-400">Calculando total en dólares… (≈ ₡{Number(totalCRC).toLocaleString('es-CR')})</p>
      )}
      {sdkError ? <p className="text-xs text-red-600">{sdkError}</p> : <div ref={container} className="min-h-[50px]" />}
      {message && <p className="text-xs font-bold text-slate-700">{message}</p>}
    </div>
  );
}
