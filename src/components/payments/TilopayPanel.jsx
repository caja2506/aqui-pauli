import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { isValidTilopayPaymentUrl as safePaymentUrl } from '../../services/payments/tilopayUrl';
import { useCart } from '../../contexts/CartContext';
import { formatCRC } from '../../utils/formatters';
import { tilopayCreatePayment } from '../../services/payments/tilopayClient';

const STORAGE_KEY = 'aqp_tilopay_pending';
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


export default function TilopayPanel({ totalCRC, validateForm, createPendingOrder, canton }) {
  const { user } = useAuth();
  const { items } = useCart();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pendingOrder, setPendingOrder] = useState(null);
  const pendingRef = useRef(null);
  const busyRef = useRef(false);
  const activeUid = useRef(user?.uid);
  activeUid.current = user?.uid;

  useEffect(() => {
    const pending = user?.uid ? readPending(user.uid) : null;
    pendingRef.current = pending;
    setPendingOrder(pending);
    setMessage('');
  }, [user?.uid]);

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
    const uid = user?.uid;
    try {
      if (!uid) { setMessage('Iniciá sesión antes de continuar con el pago.'); return; }
      let pending = pendingRef.current?.uid === uid ? pendingRef.current : readPending(uid);
      const currentCartKey = cartKey(items);
      if (pending && pending.cartKey && pending.cartKey !== currentCartKey) {
        remember(pending);
        setMessage('Hay un pago pendiente de otro carrito. Verificá ese pedido antes de iniciar otra compra con tarjeta.');
        return;
      }
      if (!pending) {
        if (!validateForm()) { setMessage('Completá los datos de contacto y envío antes de pagar.'); return; }
        const created = await createPendingOrder('tilopay');
        if (activeUid.current !== uid) return;
        if (typeof created?.orderId !== 'string' || !created.orderId) throw new Error('No pudimos identificar el pedido.');
        pending = {
          uid, orderId: created.orderId, orderNumber: created.orderNumber || null,
          total: totalCRC, cartKey: currentCartKey,
        };
        // Persist before the callable: a timeout must not lose the order to reconcile.
        remember(pending);
      } else {
        remember(pending);
      }

      const res = await tilopayCreatePayment({ orderId: pending.orderId });
      if (activeUid.current !== uid) return;
      const actualId = typeof res?.orderId === 'string' && res.orderId ? res.orderId : pending.orderId;
      const sameOrder = actualId === pending.orderId;
      pending = {
        uid, orderId: actualId, orderNumber: res?.orderNumber || (sameOrder ? pending.orderNumber : null),
        total: res?.crcTotal ?? (sameOrder ? pending.total : null),
        cartKey: sameOrder ? pending.cartKey : currentCartKey,
      };
      // A server checkout lock can redirect us to the user's original equivalent order.
      remember(pending);
      if (safePaymentUrl(res?.url)) {
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
      console.error('tilopayCreatePayment:', error?.code || 'unknown');
      setMessage(pendingRef.current
        ? 'No pudimos completar la conexión. Conservamos tu pedido; verificá su estado antes de iniciar otro pago.'
        : (error?.message || 'No pudimos crear el pedido. Intentá nuevamente.'));
    } finally {
      if (!leaving) { busyRef.current = false; setBusy(false); }
    }
  };

  const visiblePending = pendingOrder?.uid === user?.uid ? pendingOrder : null;
  return (
    <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-200 space-y-3">
      <p className="text-xs font-bold text-emerald-800">Pago con tarjeta en colones</p>
      <p className="text-sm text-slate-800">
        Total del carrito: <span className="font-black">{formatCRC(totalCRC)}</span>
        {!canton && <span className="block text-[11px] text-slate-500">Seleccioná tu cantón para ver el total final.</span>}
      </p>
      {visiblePending && <p className="text-sm text-slate-700">Hay un pedido de tarjeta pendiente. Continuaremos con ese mismo pedido.</p>}
      <p className="text-[11px] text-slate-500">Ingresarás tu tarjeta en la página segura de Tilopay. Aquí Pauli no recibe esos datos.</p>
      <button type="button" onClick={pay} disabled={busy || !user}
        className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed">
        {busy ? 'Verificando…' : visiblePending ? 'Continuar el pedido pendiente' : `Pagar ${formatCRC(totalCRC)} con tarjeta`}
      </button>
      {visiblePending && <Link className="block text-center text-sm font-bold underline text-emerald-900"
        to={`/tilopay/retorno/${encodeURIComponent(visiblePending.orderId)}`}>Verificar el pedido pendiente</Link>}
      {message && <p role="status" className="text-xs font-bold text-red-700">{message}</p>}
    </div>
  );
}
