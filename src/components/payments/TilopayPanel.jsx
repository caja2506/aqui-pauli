import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { isValidTilopayPaymentUrl as safePaymentUrl } from '../../services/payments/tilopayUrl';
import { useCart } from '../../contexts/CartContext';
import { formatCRC } from '../../utils/formatters';
import { BACKORDER_BALANCE_TIMING, BACKORDER_DEPOSIT_LABEL } from '../../utils/backorder';
import { tilopayCreatePayment, tilopayGetQuote } from '../../services/payments/tilopayClient';
import { isPayableTilopayQuote, sameTilopayQuote, tilopayQuoteKey, tilopayQuoteAmounts } from '../../services/payments/tilopayQuote';

import { pilotStorageKey } from '../../services/payments/tilopayPilot';
const STORAGE_KEY = pilotStorageKey('aqp_tilopay_pending');
const QUOTE_MESSAGES = {
  CATALOG_UNAVAILABLE: 'Un producto o variante del carrito está desactivado. Revisá el carrito antes de pagar.',
  CATALOG_NOT_FOUND: 'Un producto o variante ya no existe. Quitalo del carrito y agregalo nuevamente desde el catálogo.',
  CATALOG_PRICE_INVALID: 'Un producto necesita una corrección de precio. Contactanos antes de pagar.',
  CATALOG_STOCK_INVALID: 'Un producto necesita una revisión de inventario. Contactanos antes de pagar.',
  CATALOG_SUPPLY_INVALID: 'Un producto necesita una revisión de disponibilidad. Contactanos antes de pagar.',
  INVALID_ITEM: 'Hay una cantidad o variante inválida. Revisá el carrito antes de pagar.',
  DUPLICATE_VARIANT: 'Hay una variante repetida. Revisá las cantidades en el carrito antes de pagar.',
  INVALID_ITEM_COUNT: 'Revisá el carrito: debe tener entre 1 y 50 productos distintos.',
  INVALID_SHIPPING_TYPE: 'Seleccioná nuevamente el tipo de envío.',
  INVALID_CANTON: 'Seleccioná nuevamente el cantón de entrega.',
};
const cartKey = (items) => JSON.stringify((Array.isArray(items) ? items : []).map((item) => [
  String(item.productId ?? ''), String(item.variantId ?? ''), Number(item.quantity),
]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

function readPending(uid) {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    return value?.uid === uid && typeof value.orderId === 'string' && value.orderId ? value : null;
  } catch { return null; }
}
function writePending(value) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Server checkout locks still protect the order. */ }
}


export default function TilopayPanel({ validateForm, createPendingOrder, canton, shippingType = 'normal', onQuote }) {
  const { user } = useAuth();
  const { items } = useCart();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pendingOrder, setPendingOrder] = useState(() => user?.uid ? readPending(user.uid) : null);
  const [quoted, setQuoted] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  const pendingRef = useRef(pendingOrder);
  const busyRef = useRef(false);
  const latest = useRef({});
  const mounted = useRef(true);
  const uid = user?.uid;
  const quoteKey = tilopayQuoteKey(items, canton, shippingType);
  const quote = quoted?.uid === uid && quoted.key === quoteKey && isPayableTilopayQuote(quoted.quote) ? quoted.quote : null;
  const error = quoteError?.uid === uid && quoteError.key === quoteKey ? quoteError.message : '';
  const visiblePending = pendingOrder?.uid === uid ? pendingOrder : null;
  const pendingMatches = !visiblePending || ((!visiblePending.cartKey || visiblePending.cartKey === cartKey(items))
    && (!visiblePending.quoteKey || visiblePending.quoteKey === quoteKey));
  // A resumed order keeps the server quote of its original attempt, even when
  // catalog prices have changed. Never present the new cart as its charge.
  const displayedQuote = visiblePending
    ? (pendingMatches && isPayableTilopayQuote(visiblePending.quote) ? visiblePending.quote : null) : quote;
  latest.current = { uid, quoteKey, quote, error, onQuote };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const pending = uid ? readPending(uid) : null;
    pendingRef.current = pending;
    setPendingOrder(pending);
    setMessage('');
  }, [uid]);

  useEffect(() => {
    let cancelled = false;
    setQuoted(null);
    setQuoteError(null);
    // The pending order owns its server-priced snapshot. The current cart is
    // irrelevant to resuming it, including after catalog/stock changes.
    if (!uid || !canton || items.length === 0 || visiblePending || readPending(uid)) return undefined;
    tilopayGetQuote({
      items: items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
      canton, shippingType,
    }).then(value => {
      if (cancelled || latest.current.uid !== uid || latest.current.quoteKey !== quoteKey) return;
      if (!isPayableTilopayQuote(value)) throw new Error('Cotización inválida.');
      setQuoted({ uid, key: quoteKey, quote: value });
    }).catch((failure) => {
      if (!cancelled && latest.current.uid === uid && latest.current.quoteKey === quoteKey) {
        const reason = failure?.details?.reason;
        const message = Object.hasOwn(QUOTE_MESSAGES, reason) ? QUOTE_MESSAGES[reason]
          : 'No pudimos confirmar el importe con el servidor. Volvé a calcular antes de pagar.';
        setQuoteError({ uid, key: quoteKey, message });
      }
    });
    return () => { cancelled = true; };
    // The key includes all product ids, variants, quantities and shipping choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, quoteKey, quoteRefresh, visiblePending?.orderId]);

  useEffect(() => {
    latest.current.onQuote?.({ uid, key: quoteKey, quote: displayedQuote });
    // A remounted card panel must recalculate instead of inheriting a quote
    // retained by the checkout while another payment method was selected.
    return () => { latest.current.onQuote?.({ uid, key: quoteKey, quote: null }); };
  }, [uid, quoteKey, displayedQuote]);

  const remember = (pending) => {
    pendingRef.current = pending;
    setPendingOrder(pending);
    writePending(pending);
  };

  const pay = async () => {
    if (busyRef.current) return; // Immediate guard, before React renders disabled=true.
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    let leaving = false;
    try {
      if (!uid) { setMessage('Iniciá sesión antes de continuar con el pago.'); return; }
      let pending = pendingRef.current?.uid === uid ? pendingRef.current : readPending(uid);
      const currentCartKey = cartKey(items);
      if (pending && ((pending.cartKey && pending.cartKey !== currentCartKey)
        || (pending.quoteKey && pending.quoteKey !== quoteKey))) {
        remember(pending);
        setMessage('Hay un pedido pendiente con otro carrito o envío. Verificá ese pedido antes de iniciar otra compra con tarjeta.');
        return;
      }
      if (!pending) {
        if (!quote || error || latest.current.quoteKey !== quoteKey || latest.current.uid !== uid) {
          setMessage('Esperá a que el servidor confirme el importe a pagar.');
          return;
        }
        if (!validateForm()) { setMessage('Completá los datos de contacto y envío antes de pagar.'); return; }
        const created = await createPendingOrder('tilopay');
        if (latest.current.uid !== uid) return;
        if (typeof created?.orderId !== 'string' || !created.orderId) throw new Error('No pudimos identificar el pedido.');
        pending = {
          uid, orderId: created.orderId, orderNumber: created.orderNumber || null,
          total: quote.crcTotal, quote, quoteKey, cartKey: currentCartKey,
        };
        // Persist before the callable: a timeout must not lose the order to reconcile.
        remember(pending);
        if (!mounted.current || latest.current.quoteKey !== quoteKey || !sameTilopayQuote(quote, latest.current.quote)) {
          setMessage('El carrito o el envío cambió. Conservamos el pedido; revisalo antes de continuar con el pago.');
          return;
        }
      } else {
        remember(pending);
      }

      const expectedQuote = isPayableTilopayQuote(pending.quote) ? pending.quote : null;
      const res = await tilopayCreatePayment({ orderId: pending.orderId, ...(expectedQuote ? { expectedQuote } : {}) });
      if (latest.current.uid !== uid) return;
      const actualId = typeof res?.orderId === 'string' && res.orderId ? res.orderId : pending.orderId;
      const sameOrder = actualId === pending.orderId;
      pending = {
        uid, orderId: actualId, orderNumber: res?.orderNumber || (sameOrder ? pending.orderNumber : null),
        total: res?.crcTotal ?? (sameOrder ? pending.total : null),
        quote: tilopayQuoteAmounts(res) || (sameOrder ? pending.quote : null),
        quoteKey: sameOrder ? pending.quoteKey : quoteKey,
        cartKey: sameOrder ? pending.cartKey : currentCartKey,
      };
      // A server checkout lock can redirect us to the user's original equivalent order.
      remember(pending);
      if (!mounted.current || latest.current.quoteKey !== quoteKey) return;
      if (res?.formUnavailable === true) {
        setMessage(res.message || 'No se pudo abrir el formulario de Tilopay. Conservá este pedido para consultarlo.');
        return;
      }
      if (safePaymentUrl(res?.url)) {
        if (!isPayableTilopayQuote(res)) {
          navigate(`/tilopay/retorno/${encodeURIComponent(actualId)}`);
          leaving = true;
          return;
        }
        if (!expectedQuote || !sameTilopayQuote(expectedQuote, res)) {
          setMessage('Revisá el importe confirmado de este pedido y continuá nuevamente para aprobarlo. Los pedidos anteriores conservan su monto original.');
          return;
        }
        window.location.assign(res.url);
        leaving = true;
        return;
      }
      if (['pending', 'review', 'paid', 'already_paid', 'test_paid', 'declined'].includes(res?.result)) {
        navigate(`/tilopay/retorno/${encodeURIComponent(actualId)}`);
        leaving = true;
        return;
      }
      setMessage('Todavía no conocemos el resultado. Verificá este mismo pedido antes de volver a pagar.');
    } catch (error) {
      if (!mounted.current || latest.current.uid !== uid) return;
      console.error('tilopayCreatePayment:', error?.code || 'unknown');
      if (isPayableTilopayQuote(error?.details?.quote) && pendingRef.current?.uid === uid) {
        remember({ ...pendingRef.current, quote: tilopayQuoteAmounts(error.details.quote), total: error.details.quote.crcTotal });
        setMessage('El importe del pedido cambió. Revisá el monto actualizado y continuá con este mismo pedido para aprobarlo.');
        return;
      }
      setMessage(pendingRef.current
        ? 'No pudimos completar la conexión. Conservamos tu pedido; verificá su estado antes de iniciar otro pago.'
        : (error?.message || 'No pudimos crear el pedido. Intentá nuevamente.'));
    } finally {
      if (!leaving) { busyRef.current = false; setBusy(false); }
    }
  };

  const isDeposit = !!displayedQuote?.hasBackorder && displayedQuote.crcBalanceDue > 0;
  return (
    <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-200 space-y-3">
      <p className="text-xs font-bold text-emerald-800">Pago con tarjeta en colones</p>
      {displayedQuote ? <div className="text-sm text-slate-800 space-y-1" data-testid="tilopay-quote">
        <p className="font-black text-emerald-900">Pagás ahora {formatCRC(displayedQuote.crcPayNow)}{isDeposit ? ` (apartado ${BACKORDER_DEPOSIT_LABEL})` : ''}</p>
        <p>Total del pedido: <strong>{formatCRC(displayedQuote.crcTotal)}</strong> · Saldo pendiente: <strong>{formatCRC(displayedQuote.crcBalanceDue)}</strong></p>
        {isDeposit && <>
          <p>Incluye el {BACKORDER_DEPOSIT_LABEL} de los productos Bajo pedido, más los productos en stock y el envío completos.</p>
          <p className="text-xs">El saldo se paga {BACKORDER_BALANCE_TIMING}.</p>
        </>}
      </div> : visiblePending ? <p className="text-xs text-slate-600">Consultaremos el importe y el estado del pedido pendiente en el servidor.</p>
        : !canton ? <p className="text-xs text-slate-500">Seleccioná tu cantón para confirmar el importe a pagar.</p>
          : error ? <div role="alert" className="text-xs text-red-700 space-y-2">
            <p>{error}</p>
            <Link to="/carrito" className="block font-bold underline">Revisar carrito</Link>
            <button type="button" className="font-bold underline" onClick={() => setQuoteRefresh(value => value + 1)}>Volver a calcular</button>
          </div> : <p className="text-xs text-slate-500" role="status">Calculando el importe a pagar en el servidor…</p>}
      {visiblePending && <p className="text-sm text-slate-700">Hay un pedido de tarjeta pendiente. Continuaremos con ese mismo pedido.</p>}
      {!pendingMatches && <p className="text-xs font-bold text-red-700">Ese pedido tiene otro carrito o envío. Verificá el pedido pendiente antes de iniciar otra compra con tarjeta.</p>}
      <p className="text-[11px] text-slate-500">Ingresarás tu tarjeta en la página segura de Tilopay. Aquí Pauli no recibe esos datos.</p>
      <button type="button" onClick={pay} disabled={busy || !uid || (!visiblePending && (!quote || !!error)) || !pendingMatches}
        className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed">
        {busy ? 'Verificando…' : visiblePending ? 'Continuar el pedido pendiente' : quote && !error
          ? `Pagás ahora ${formatCRC(quote.crcPayNow)}${isDeposit ? ` (apartado ${BACKORDER_DEPOSIT_LABEL})` : ''} con tarjeta` : 'Calculando…'}
      </button>
      {visiblePending && <Link className="block text-center text-sm font-bold underline text-emerald-900"
        to={`/tilopay/retorno/${encodeURIComponent(visiblePending.orderId)}`}>Verificar el pedido pendiente</Link>}
      {message && <p role="status" className="text-xs font-bold text-red-700">{message}</p>}
    </div>
  );
}
