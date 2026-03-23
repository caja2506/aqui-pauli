import { useState, useEffect } from 'react';
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Link } from 'react-router-dom';
import { Package, ChevronRight, ShoppingBag, LogIn } from 'lucide-react';
import { formatCRC, formatDateTime } from '../../utils/formatters';
import { ORDER_STATUS_LABELS } from '../../utils/constants';

const PAYMENT_STATUS_LABELS = {
  pendiente: { text: '💳 Pendiente', color: 'bg-red-50 text-red-600' },
  verificando: { text: '⏳ Verificando', color: 'bg-amber-50 text-amber-700' },
  revision_humana: { text: '👁️ En revisión', color: 'bg-orange-50 text-orange-700' },
  verificado: { text: '✅ Verificado', color: 'bg-emerald-50 text-emerald-700' },
  rechazado: { text: '❌ Rechazado', color: 'bg-red-50 text-red-600' },
};

export default function MyOrdersPage() {
  const { user, loading: authLoading } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user?.uid) { setLoading(false); return; }

    const fetchOrders = async () => {
      try {
        // Buscar por uid
        const q = query(
          collection(db, 'orders'),
          where('uid', '==', user.uid),
          orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        setOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch (err) {
        console.error('Error cargando pedidos:', err);
        // Si falla el índice, intentar sin orderBy
        try {
          const q2 = query(collection(db, 'orders'), where('uid', '==', user.uid));
          const snap2 = await getDocs(q2);
          const sorted = snap2.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
          setOrders(sorted);
        } catch (err2) {
          console.error('Error cargando pedidos (fallback):', err2);
        }
      } finally {
        setLoading(false);
      }
    };
    fetchOrders();
  }, [user, authLoading]);

  // No logueado
  if (!authLoading && !user) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <LogIn className="w-12 h-12 text-slate-300 mx-auto mb-4" />
        <h1 className="text-xl font-black text-slate-900 mb-2">Iniciá sesión</h1>
        <p className="text-sm text-slate-500 mb-6">Para ver tus pedidos necesitás iniciar sesión.</p>
        <Link to="/login" className="inline-flex items-center gap-2 px-6 py-3 bg-rose-600 text-white font-bold rounded-xl text-sm">
          Iniciar Sesión
        </Link>
      </div>
    );
  }

  if (loading || authLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-rose-200 border-t-rose-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <ShoppingBag className="w-12 h-12 text-slate-300 mx-auto mb-4" />
        <h1 className="text-xl font-black text-slate-900 mb-2">Sin pedidos aún</h1>
        <p className="text-sm text-slate-500 mb-6">Todavía no tenés pedidos. ¡Explorá nuestro catálogo!</p>
        <Link to="/catalogo" className="inline-flex items-center gap-2 px-6 py-3 bg-rose-600 text-white font-bold rounded-xl text-sm">
          Ver Catálogo
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <h1 className="text-2xl font-black text-slate-900 mb-6">Mis Pedidos</h1>

      <div className="space-y-4">
        {orders.map(order => {
          const items = order.itemsSummary || [];
          const total = order.total || (order.subtotal || 0) + (order.shippingCost || 0);
          const statusLabel = ORDER_STATUS_LABELS[order.status] || order.status;
          const paymentInfo = PAYMENT_STATUS_LABELS[order.paymentStatus] || PAYMENT_STATUS_LABELS.pendiente;

          return (
            <div key={order.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-slate-50">
                <div>
                  <p className="text-xs font-bold text-rose-600">{order.orderNumber}</p>
                  <p className="text-[10px] text-slate-400">{formatDateTime(order.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${paymentInfo.color}`}>{paymentInfo.text}</span>
                  <span className="text-[9px] font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{statusLabel}</span>
                </div>
              </div>

              {/* Items */}
              <div className="p-4 space-y-3">
                {items.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-lg bg-slate-50 border border-slate-200 overflow-hidden shrink-0">
                      {item.imageUrl ? <img src={item.imageUrl} alt="" className="w-full h-full object-cover" /> : <Package className="w-6 h-6 text-slate-300 m-auto mt-3" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-slate-900 truncate">{item.productName}</p>
                      <p className="text-[10px] text-slate-400">{item.variantName} × {item.quantity}</p>
                    </div>
                    <span className="text-xs font-bold text-slate-700">{formatCRC(item.lineTotal || item.price * item.quantity)}</span>
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between p-4 bg-slate-50 border-t border-slate-100">
                <div className="text-xs text-slate-500">
                  {order.shippingAddress && (
                    <span>📍 {order.shippingAddress.provincia}, {order.shippingAddress.canton}</span>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-slate-400">Total</p>
                  <p className="text-sm font-black text-slate-900">{formatCRC(total)}</p>
                </div>
              </div>

              {/* WhatsApp para enviar comprobante si pago pendiente */}
              {(order.paymentStatus === 'pendiente' || !order.paymentStatus) && (
                <div className="px-4 pb-4">
                  <a
                    href={`https://wa.me/50670956070?text=${encodeURIComponent(`¡Hola! Envío mi comprobante para el pedido ${order.orderNumber}`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 w-full py-3 bg-[#25D366] hover:bg-[#1ebe57] text-white font-bold rounded-xl text-xs transition-all"
                  >
                    📸 Enviar Comprobante por WhatsApp <ChevronRight className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
