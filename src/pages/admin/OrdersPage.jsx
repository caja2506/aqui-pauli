import React, { useState, useEffect } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';
import { Search, ClipboardList, ChevronDown, MapPin, Package, Phone } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { updateOrderStatus } from '../../services/orderService';
import { formatCRC, formatDateTime } from '../../utils/formatters';
import { ORDER_STATUS_LABELS, ORDER_STATUS } from '../../utils/constants';
import StatusBadge from '../../components/ui/StatusBadge';
import EmptyState from '../../components/ui/EmptyState';

const STATUS_FLOW = [
  ORDER_STATUS.PENDIENTE_PAGO,
  ORDER_STATUS.REVISION_MANUAL,
  ORDER_STATUS.PAGADO,
  ORDER_STATUS.POR_PREPARAR,
  ORDER_STATUS.PREPARANDO,
  ORDER_STATUS.ENVIADO,
  ORDER_STATUS.ENTREGADO,
  ORDER_STATUS.CANCELADO,
];

export default function OrdersPage() {
  const { data: orders, loading } = useCollection('orders', { orderByField: 'createdAt', orderDirection: 'desc' });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [loadedItems, setLoadedItems] = useState({}); // cache de items por orderId

  const filteredOrders = orders.filter(o => {
    const s = search.toLowerCase();
    const matchesSearch = !s || (o.orderNumber || '').toLowerCase().includes(s) || (o.customerName || '').toLowerCase().includes(s) || (o.customerEmail || '').toLowerCase().includes(s);
    const matchesStatus = !statusFilter || o.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleStatusChange = async (orderId, newStatus) => {
    await updateOrderStatus(orderId, newStatus);
  };

  // Obtener el total de la orden (soporta ambos formatos)
  const getOrderTotal = (order) => {
    if (order.total) return order.total;
    // Formato viejo: depositTotal + remainingTotal
    return (order.depositTotal || 0) + (order.remainingTotal || 0) + (order.shippingCost || 0);
  };

  // Cargar items cuando se expande una orden
  const toggleExpand = async (orderId) => {
    if (expandedOrder === orderId) {
      setExpandedOrder(null);
      return;
    }
    setExpandedOrder(orderId);

    // Si ya tenemos items cargados o la orden tiene itemsSummary, no hacer nada
    const order = orders.find(o => o.id === orderId);
    if (loadedItems[orderId] || (order?.itemsSummary && order.itemsSummary.length > 0)) return;

    // Cargar items de la sub-colección
    try {
      const itemsSnap = await getDocs(collection(db, 'orders', orderId, 'items'));
      const items = itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setLoadedItems(prev => ({ ...prev, [orderId]: items }));
    } catch (err) {
      console.error('Error loading order items:', err);
    }
  };

  // Obtener items (de itemsSummary o de sub-colección cargada)
  const getOrderItems = (order) => {
    if (order.itemsSummary && order.itemsSummary.length > 0) return order.itemsSummary;
    if (loadedItems[order.id]) return loadedItems[order.id];
    return [];
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
        <h2 className="font-black text-2xl text-slate-800 tracking-tight">Pedidos</h2>
        <p className="text-sm text-slate-400 mt-1">{orders.length} pedido{orders.length !== 1 ? 's' : ''} totales</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por # orden, cliente..." className="w-full pl-12 pr-4 py-3 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-indigo-500 bg-white shadow-sm" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="px-4 py-3 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-indigo-500 bg-white">
          <option value="">Todos los estados</option>
          {Object.entries(ORDER_STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {/* Orders */}
      {filteredOrders.length > 0 ? (
        <div className="space-y-3">
          {filteredOrders.map(order => {
            const isExpanded = expandedOrder === order.id;
            const addr = order.shippingAddress || {};
            const items = getOrderItems(order);
            const total = getOrderTotal(order);
            const itemCount = order.itemCount || items.length;

            return (
              <div key={order.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                {/* Header row */}
                <div
                  className="flex flex-wrap items-center gap-4 p-5 cursor-pointer hover:bg-slate-50 transition-colors"
                  onClick={() => toggleExpand(order.id)}
                >
                  <button className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                    <ChevronDown className="w-4 h-4 text-slate-400" />
                  </button>

                  <div className="min-w-[100px]">
                    <span className="font-mono font-bold text-indigo-600 text-xs">{order.orderNumber}</span>
                    <p className="text-[10px] text-slate-400 mt-0.5">{formatDateTime(order.createdAt)}</p>
                  </div>

                  <div className="flex-1 min-w-[150px]">
                    <p className="font-bold text-slate-900 text-sm">{order.customerName}</p>
                    <p className="text-[10px] text-slate-400">{order.customerEmail}</p>
                  </div>

                  <div className="flex items-center gap-1 text-xs text-slate-500">
                    <Package className="w-3 h-3" />
                    <span>{itemCount} item{itemCount !== 1 ? 's' : ''}</span>
                  </div>

                  <StatusBadge status={order.status} />

                  <span className="text-sm font-black text-slate-900 min-w-[90px] text-right">{formatCRC(total)}</span>

                  <select
                    value={order.status}
                    onChange={e => { e.stopPropagation(); handleStatusChange(order.id, e.target.value); }}
                    onClick={e => e.stopPropagation()}
                    className="text-xs px-3 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold"
                  >
                    {STATUS_FLOW.map(s => (
                      <option key={s} value={s}>{ORDER_STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                </div>

                {/* Expanded Detail */}
                {isExpanded && (
                  <div className="border-t border-slate-100 bg-slate-50 p-5 space-y-5 animate-in fade-in duration-200">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      {/* Productos comprados */}
                      <div>
                        <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Productos Comprados</h4>
                        {items.length > 0 ? (
                          <div className="space-y-2">
                            {items.map((item, idx) => (
                              <div key={idx} className="bg-white rounded-xl p-3 border border-slate-200 flex items-center gap-3">
                                <div className="w-12 h-12 rounded-lg bg-slate-50 border border-slate-200 overflow-hidden shrink-0">
                                  {item.imageUrl ? (
                                    <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center"><Package className="w-5 h-5 text-slate-200" /></div>
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-bold text-slate-900 truncate">{item.productName}</p>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-[10px] text-slate-400">{item.variantName}</span>
                                    <span className="text-[10px] text-slate-400">× {item.quantity}</span>
                                    {item.supplyType === 'bajo_pedido' && (
                                      <span className="text-[9px] font-bold bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded">BAJO PEDIDO</span>
                                    )}
                                  </div>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="text-xs text-slate-400">{formatCRC(item.price)} c/u</p>
                                  <p className="text-sm font-black text-slate-900">{formatCRC(item.lineTotal || item.price * item.quantity)}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-slate-400 bg-white p-3 rounded-xl border flex items-center gap-2">
                            <div className="animate-spin w-3 h-3 border-2 border-slate-300 border-t-indigo-500 rounded-full" />
                            Cargando items...
                          </div>
                        )}

                        {/* Totals */}
                        <div className="mt-3 bg-white rounded-xl p-3 border border-slate-200 space-y-1 text-sm">
                          <div className="flex justify-between"><span className="text-slate-400">Subtotal</span><span>{formatCRC(order.subtotal || order.depositTotal || 0)}</span></div>
                          <div className="flex justify-between"><span className="text-slate-400">Envío ({order.shippingType || 'normal'})</span><span>{formatCRC(order.shippingCost || 0)}</span></div>
                          <div className="flex justify-between font-black text-slate-900 pt-1 border-t"><span>Total</span><span>{formatCRC(total)}</span></div>
                          {order.hasBackorder && (
                            <div className="flex justify-between text-amber-600 font-bold text-xs pt-1">
                              <span>Adelanto 20% (bajo pedido)</span><span>{formatCRC(order.backorderDeposit)}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Dirección y datos del cliente */}
                      <div className="space-y-4">
                        <div>
                          <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Dirección de Envío</h4>
                          <div className="bg-white rounded-xl p-4 border border-slate-200 space-y-2">
                            {addr.provincia || addr.canton ? (
                              <>
                                <div className="flex items-start gap-2">
                                  <MapPin className="w-4 h-4 text-indigo-500 mt-0.5 shrink-0" />
                                  <div>
                                    <p className="text-sm font-bold text-slate-900">{[addr.provincia, addr.canton].filter(Boolean).join(', ')}</p>
                                    <p className="text-xs text-slate-500">{addr.distrito} {addr.codigoPostal ? `(${addr.codigoPostal})` : ''}</p>
                                  </div>
                                </div>
                                <div className="pl-6">
                                  <p className="text-xs text-slate-600 bg-slate-50 rounded-lg p-2">{addr.señas || addr.senas || 'Sin señas adicionales'}</p>
                                </div>
                              </>
                            ) : (
                              <p className="text-xs text-slate-400">Sin dirección registrada</p>
                            )}
                          </div>
                        </div>

                        <div>
                          <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Datos del Cliente</h4>
                          <div className="bg-white rounded-xl p-4 border border-slate-200 space-y-2">
                            <div className="flex items-center gap-2">
                              <Phone className="w-3.5 h-3.5 text-slate-400" />
                              <span className="text-sm text-slate-700">{order.customerPhone || 'Sin teléfono'}</span>
                            </div>
                            <div className="text-xs text-slate-400">
                              <p>Método de pago: <span className="font-bold text-slate-600 capitalize">{order.paymentMethod?.replace('_', ' ')}</span></p>
                              {order.paymentPhone && <p>Tel. SINPE: <span className="font-bold text-slate-600">{order.paymentPhone}</span></p>}
                              <p>Estado de pago: <span className="font-bold text-slate-600 capitalize">{order.paymentStatus || 'pendiente'}</span></p>
                            </div>
                          </div>
                        </div>

                        {order.notes && (
                          <div>
                            <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-2">Notas</h4>
                            <p className="text-xs text-slate-600 bg-white rounded-xl p-3 border border-slate-200">{order.notes}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={ClipboardList} title="Sin pedidos" message="Los pedidos aparecerán aquí cuando los clientes compren" />
      )}
    </div>
  );
}
