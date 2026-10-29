import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useCart } from '../../contexts/CartContext';
import { tilopayConfirm } from '../../services/payments/tilopayClient';

/**
 * Tilopay redirige aquí al terminar el pago. Lo que viene en la URL NO se usa
 * para decidir nada: el servidor confirma el pago con la API de Tilopay.
 */
export default function TilopayReturnPage() {
  const { orderId } = useParams();
  const { user, loading: authLoading } = useAuth();
  const { clearCart } = useCart();
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading', message: '' });
  const started = useRef(false);

  useEffect(() => {
    if (authLoading || started.current) return;
    if (!user) return;
    started.current = true;
    tilopayConfirm({ orderId }).then((res) => {
      if (res.result === 'paid' || res.result === 'already_paid' || res.result === 'review') {
        let pending = {};
        try { pending = JSON.parse(sessionStorage.getItem('aqp_tilopay_pending') || '{}'); sessionStorage.removeItem('aqp_tilopay_pending'); } catch { /* ignorar */ }
        clearCart();
        navigate(`/orden-confirmada/${orderId}`, {
          replace: true,
          state: {
            orderNumber: pending.orderNumber, total: pending.total, paymentMethod: 'tilopay',
            online: true, paid: res.result !== 'review', onlineLabel: 'tarjeta',
          },
        });
      } else {
        setState({ status: 'failed', message: res.message || 'El pago no se completó.' });
      }
    }).catch((e) => {
      console.error('tilopayConfirm:', e);
      setState({ status: 'error', message: 'No pudimos confirmar tu pago todavía. Si te cobraron, escríbenos por WhatsApp con tu número de pedido y lo resolvemos.' });
    });
  }, [authLoading, user, orderId, clearCart, navigate]);

  const noSession = !authLoading && !user;
  const view = noSession
    ? { status: 'error', message: 'No pudimos verificar tu sesión. Abre de nuevo el enlace desde el mismo navegador donde compraste.' }
    : state;

  if (view.status === 'loading') {
    return (
      <div className="max-w-md mx-auto px-4 py-24 text-center">
        <Loader2 className="w-10 h-10 text-rose-500 animate-spin mx-auto mb-4" />
        <h1 className="text-xl font-black text-slate-900">Confirmando tu pago…</h1>
        <p className="text-sm text-slate-400 mt-2">No cierres esta página.</p>
      </div>
    );
  }
  return (
    <div className="max-w-md mx-auto px-4 py-24 text-center">
      <h1 className="text-xl font-black text-slate-900 mb-2">{view.status === 'failed' ? 'El pago no se completó' : 'Algo salió mal'}</h1>
      <p className="text-sm text-slate-500 mb-6">{view.message}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Link to="/checkout" className="px-6 py-3 bg-rose-600 text-white text-sm font-bold rounded-2xl">Volver al checkout</Link>
        <a href="https://wa.me/50671613342" target="_blank" rel="noopener noreferrer" className="px-6 py-3 bg-white text-slate-900 text-sm font-bold rounded-2xl border border-slate-200">Escribir por WhatsApp</a>
      </div>
    </div>
  );
}
