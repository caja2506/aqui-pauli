import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { isValidTilopayPaymentUrl as safePaymentUrl } from '../../services/payments/tilopayUrl';
import { useCart } from '../../contexts/CartContext';
import { tilopayConfirm, tilopayCreatePayment } from '../../services/payments/tilopayClient';
import { tilopayQuoteAmounts } from '../../services/payments/tilopayQuote';

const STORAGE_KEY = 'aqp_tilopay_pending';
const cartKey = (items) => JSON.stringify((Array.isArray(items) ? items : []).map((item) => [
  String(item.productId ?? ''), String(item.variantId ?? ''), Number(item.quantity),
]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
function readPending(uid, orderId) {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    return value?.uid === uid && value.orderId === orderId ? value : null;
  } catch { return null; }
}
function removePending(uid, orderId) {
  if (!readPending(uid, orderId)) return;
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Browser storage is optional. */ }
}


/** URL parameters never decide payment state: only authenticated server confirmation does. */
export default function TilopayReturnPage() {
  const { orderId } = useParams();
  const { user, loading: authLoading } = useAuth();
  const { items, clearCart } = useCart();
  const navigate = useNavigate();
  const uid = user?.uid;
  const contextKey = `${uid || ''}:${orderId || ''}`;
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState({ key: '', status: 'loading', message: '', retry: false });
  const [retryBusy, setRetryBusy] = useState(false);
  const pendingRequest = useRef(null);
  const retryGuard = useRef(false);
  const latest = useRef({ uid, orderId, items, clearCart });
  latest.current = { uid, orderId, items, clearCart };

  useEffect(() => {
    if (authLoading || !uid || !orderId) return undefined;
    let cancelled = false;
    const key = `${uid}:${orderId}`;
    setState({ key, status: 'loading', message: '', retry: false });
    // Reuse only an in-flight query. React effect cleanup does not block a fresh query or another order.
    if (pendingRequest.current?.key !== key) pendingRequest.current = { key, promise: tilopayConfirm({ orderId }) };
    const request = pendingRequest.current;
    request.promise.then((res) => {
      if (cancelled || latest.current.uid !== uid || latest.current.orderId !== orderId) return;
      if (res?.result === 'paid' || res?.result === 'already_paid') {
        const pending = readPending(uid, orderId);
        // A paid older order must not erase a newer/different cart.
        if (pending?.cartKey && pending.cartKey === cartKey(latest.current.items)) latest.current.clearCart();
        removePending(uid, orderId);
        navigate(`/orden-confirmada/${encodeURIComponent(orderId)}`, {
          replace: true,
          state: {
            orderNumber: res.orderNumber || pending?.orderNumber, total: res.crcTotal ?? pending?.total,
            paymentMethod: 'tilopay', online: true, paid: true, onlineLabel: 'tarjeta',
            partial: res.partial === true, tilopayQuote: tilopayQuoteAmounts(res),
          },
        });
        return;
      }
      if (res?.result === 'test_paid') {
        removePending(uid, orderId);
        setState({ key, status: 'test', retry: false, message: res.message || 'Pago de prueba confirmado. El pedido no se marcó como pagado para entrega.' });
      } else if (res?.result === 'declined') {
        setState({ key, status: 'declined', retry: res.retry === true, message: res.message || 'El banco no aprobó este intento.' });
      } else {
        setState({ key, status: res?.result === 'review' ? 'review' : 'pending', retry: false,
          message: res?.message || 'Aún verificamos este pago. No iniciés otro mientras aclaramos el resultado.' });
      }
    }).catch((error) => {
      if (cancelled || latest.current.uid !== uid || latest.current.orderId !== orderId) return;
      console.error('tilopayConfirm:', error?.code || 'unknown');
      setState({ key, status: 'pending', retry: false, message: 'No pudimos consultar el pago todavía. Conservamos el pedido; consultá nuevamente antes de volver a pagar.' });
    }).finally(() => {
      if (pendingRequest.current === request) pendingRequest.current = null;
    });
    return () => { cancelled = true; };
  }, [authLoading, uid, orderId, refresh, navigate]);

  const retryPayment = async () => {
    if (retryGuard.current || !uid || state.status !== 'declined' || !state.retry) return;
    retryGuard.current = true;
    setRetryBusy(true);
    try {
      // This action is exposed only when the server explicitly permits it, and keeps the same order.
      const res = await tilopayCreatePayment({ orderId });
      if (latest.current.uid !== uid || latest.current.orderId !== orderId) return;
      const actualId = typeof res?.orderId === 'string' && res.orderId ? res.orderId : orderId;
      const oldPending = readPending(uid, orderId);
      const record = actualId === orderId ? { ...(oldPending || {}), uid, orderId } : { uid, orderId: actualId };
      const confirmedQuote = tilopayQuoteAmounts(res);
      if (confirmedQuote) { record.quote = confirmedQuote; record.total = confirmedQuote.crcTotal; }
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record)); } catch { /* Server lock remains authoritative. */ }
      if (safePaymentUrl(res?.url)) { window.location.assign(res.url); return; }
      if (actualId !== orderId) navigate(`/tilopay/retorno/${encodeURIComponent(actualId)}`, { replace: true });
      else setRefresh((value) => value + 1);
    } catch (error) {
      console.error('tilopayRetry:', error?.code || 'unknown');
      setState({ key: contextKey, status: 'pending', retry: false, message: 'No conocemos el resultado del reintento. Consultá este mismo pedido antes de volver a pagar.' });
    } finally {
      retryGuard.current = false;
      setRetryBusy(false);
    }
  };

  const noSession = !authLoading && !uid;
  const view = noSession
    ? { status: 'session', retry: false, message: 'Necesitás la misma sesión con la que hiciste el pedido para verificarlo. No iniciés otro pago para resolver este problema.' }
    : state.key !== contextKey || authLoading ? { status: 'loading' } : state;

  if (view.status === 'loading') return (
    <div className="max-w-md mx-auto px-4 py-24 text-center" role="status">
      <Loader2 className="w-10 h-10 text-rose-500 animate-spin mx-auto mb-4" />
      <h1 className="text-xl font-black text-slate-900">Consultando tu pago…</h1>
      <p className="text-sm text-slate-500 mt-2">Estamos verificando este pedido con Tilopay.</p>
    </div>
  );
  const heading = view.status === 'test' ? 'Pago de prueba confirmado'
    : view.status === 'declined' ? 'El banco no aprobó este intento'
      : view.status === 'session' ? 'Verificá tu sesión' : 'Tu pago sigue en verificación';
  return (
    <div className="max-w-md mx-auto px-4 py-24 text-center">
      <h1 className="text-xl font-black text-slate-900 mb-2">{heading}</h1>
      <p className="text-sm text-slate-600 mb-3" role="status">{view.message}</p>
      <p className="text-xs text-slate-500 break-all mb-6">Pedido: {orderId}</p>
      <div className="flex flex-wrap justify-center gap-3">
        {uid && view.status !== 'test' && <button type="button" disabled={retryBusy} onClick={() => setRefresh((value) => value + 1)}
          className="px-6 py-3 bg-rose-600 text-white text-sm font-bold rounded-2xl disabled:opacity-50">Consultar este pedido nuevamente</button>}
        {view.status === 'declined' && view.retry && <button type="button" disabled={retryBusy} onClick={retryPayment}
          className="px-6 py-3 bg-white text-slate-900 text-sm font-bold rounded-2xl border border-slate-200 disabled:opacity-50">
          {retryBusy ? 'Verificando…' : 'Reintentar el mismo pedido'}
        </button>}
        <a href="https://wa.me/50671613342" target="_blank" rel="noopener noreferrer"
          className="px-6 py-3 bg-white text-slate-900 text-sm font-bold rounded-2xl border border-slate-200">Escribir por WhatsApp</a>
      </div>
    </div>
  );
}
