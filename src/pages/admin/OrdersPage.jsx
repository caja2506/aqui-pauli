import React, { useRef, useState } from 'react';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { db, functions } from '../../firebase';
import { httpsCallable } from 'firebase/functions';
import { Search, ClipboardList, ChevronDown, MapPin, Package, Phone, Image, CheckCircle, XCircle, Eye, Trash2, Edit3 } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { updateOrderStatus } from '../../services/orderService';
import { formatCRC, formatDateTime } from '../../utils/formatters';
import { ORDER_STATUS_LABELS, ORDER_STATUS, PAYMENT_METHOD_LABELS } from '../../utils/constants';
import StatusBadge from '../../components/ui/StatusBadge';
import EmptyState from '../../components/ui/EmptyState';
import ConfirmDialog from '../../components/ui/ConfirmDialog';

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

const CASH_STATUS_FLOW = [
  ORDER_STATUS.PENDIENTE_PAGO,
  ORDER_STATUS.POR_PREPARAR,
  ORDER_STATUS.PREPARANDO,
  ORDER_STATUS.ENVIADO,
  ORDER_STATUS.ENTREGADO,
];

function cashStatusOptions(order) {
  const currentIndex = CASH_STATUS_FLOW.indexOf(order.status);
  if (currentIndex < 0) return [order.status];
  const options = CASH_STATUS_FLOW.slice(currentIndex);
  if (order.paymentStatus === 'pendiente' && order.status !== ORDER_STATUS.ENTREGADO) {
    options.push(ORDER_STATUS.CANCELADO);
  }
  return options;
}

export default function OrdersPage() {
  const { data: orders, loading } = useCollection('orders', { orderByField: 'createdAt', orderDirection: 'desc' });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [loadedItems, setLoadedItems] = useState({});
  const [proofModal, setProofModal] = useState(null);
  const [editingOrder, setEditingOrder] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState({ isOpen: false, title: '', message: '', onConfirm: null });
  const [cashConfirmation, setCashConfirmation] = useState(null);
  const [cashAction, setCashAction] = useState({ orderId: '', action: '', pending: false, error: '' });
  const cashActionInFlight = useRef(false);
  const [statusAction, setStatusAction] = useState({ orderId: '', pending: false, error: '' });
  const statusActionInFlight = useRef(false);

  // Aprobar/rechazar pago manualmente
  const handlePaymentAction = async (orderId, action) => {
    try {
      const ref = doc(db, 'orders', orderId);
      if (action === 'approve') {
        await updateDoc(ref, { paymentStatus: 'verificado', status: 'pagado', updatedAt: new Date().toISOString() });
      } else {
        await updateDoc(ref, { paymentStatus: 'rechazado', updatedAt: new Date().toISOString() });
      }
    } catch (err) {
      console.error('Error actualizando pago:', err);
    }
  };
  const [editForm, setEditForm] = useState({});

  const filteredOrders = orders.filter(o => {
    const s = search.toLowerCase();
    const matchesSearch = !s || (o.orderNumber || '').toLowerCase().includes(s) || (o.customerName || '').toLowerCase().includes(s) || (o.customerEmail || '').toLowerCase().includes(s);
    const matchesStatus = !statusFilter || o.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const openCashConfirmation = (order, action) => {
    if (cashActionInFlight.current || statusActionInFlight.current || order.paymentMethod !== 'contra_entrega'
        || order.status === 'cancelado' || ['pagado', 'verificado'].includes(order.paymentStatus)) return;
    if (action === 'confirm_payment' && order.paymentStatus !== 'pendiente') return;
    if (action === 'cancel' && order.status === 'entregado') return;
    setCashConfirmation({ order, action });
  };

  const handleCashAction = async (order, action) => {
    if (cashActionInFlight.current) return;
    cashActionInFlight.current = true;
    setCashAction({ orderId: order.id, action, pending: true, error: '' });
    try {
      const manageOrder = httpsCallable(functions, 'manageCashOnDeliveryOrder');
      await manageOrder({ orderId: order.id, action });
      setCashAction({ orderId: '', action: '', pending: false, error: '' });
    } catch (error) {
      setCashAction({ orderId: order.id, action, pending: false,
        error: error?.message || 'No se pudo actualizar el pedido contra entrega. Intentá de nuevo.' });
    } finally {
      cashActionInFlight.current = false;
    }
  };

  const handleStatusChange = async (orderId, newStatus) => {
    const order = orders.find(item => item.id === orderId);
    if (order?.paymentMethod === 'contra_entrega') {
      if (cashActionInFlight.current || statusActionInFlight.current
          || !cashStatusOptions(order).includes(newStatus) || newStatus === order.status) return;
      if (newStatus === ORDER_STATUS.CANCELADO) return openCashConfirmation(order, 'cancel');
    }
    statusActionInFlight.current = true;
    setStatusAction({ orderId, pending: true, error: '' });
    try {
      await updateOrderStatus(orderId, newStatus);
      setStatusAction({ orderId: '', pending: false, error: '' });
    } catch (error) {
      setStatusAction({ orderId, pending: false,
        error: error?.message || 'No se pudo cambiar el estado del pedido. Intentá de nuevo.' });
    } finally {
      statusActionInFlight.current = false;
    }
  };

  const getOrderTotal = (order) => {
    if (order.total) return order.total;
    return (order.depositTotal || 0) + (order.remainingTotal || 0) + (order.shippingCost || 0);
  };

  const toggleExpand = async (orderId) => {
    if (expandedOrder === orderId) { setExpandedOrder(null); return; }
    setExpandedOrder(orderId);
    const order = orders.find(o => o.id === orderId);
    if (loadedItems[orderId] || (order?.itemsSummary && order.itemsSummary.length > 0)) return;
    try {
      const itemsSnap = await getDocs(collection(db, 'orders', orderId, 'items'));
      const items = itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setLoadedItems(prev => ({ ...prev, [orderId]: items }));
    } catch (err) { console.error('Error loading order items:', err); }
  };

  const getOrderItems = (order) => {
    if (order.itemsSummary && order.itemsSummary.length > 0) return order.itemsSummary;
    if (loadedItems[order.id]) return loadedItems[order.id];
    return [];
  };

  const handleApprovePayment = async (orderId) => {
    await updateDoc(doc(db, 'orders', orderId), {
      paymentStatus: 'verificado',
      status: 'pagado',
      verifiedBy: 'admin_manual',
      verifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleRejectPayment = async (orderId) => {
    await updateDoc(doc(db, 'orders', orderId), {
      paymentStatus: 'rechazado',
      updatedAt: new Date().toISOString(),
    });
  };

  const handleDeleteOrder = (orderId, orderNumber) => {
    if (orders.find(order => order.id === orderId)?.paymentMethod === 'contra_entrega') return;
    setConfirmDelete({
      isOpen: true,
      title: 'Eliminar Pedido',
      message: `¿Eliminar pedido ${orderNumber}? Esta acción no se puede deshacer.`,
      onConfirm: async () => {
        try {
          const deleteOrderFn = httpsCallable(functions, 'deleteOrder');
          await deleteOrderFn({ orderId });
          if (expandedOrder === orderId) setExpandedOrder(null);
        } catch (err) {
          console.error('Error deleting order:', err);
          alert('Error al eliminar: ' + (err.message || err));
        }
      },
    });
  };

  const handleEditOrder = (order) => {
    setEditForm({
      customerName: order.customerName || '',
      customerPhone: order.customerPhone || '',
      customerEmail: order.customerEmail || '',
      address: order.shippingAddress?.señas || order.shippingAddress?.senas || '',
      notes: order.notes || '',
    });
    setEditingOrder(order.id);
  };

  const handleSaveEdit = async () => {
    try {
      await updateDoc(doc(db, 'orders', editingOrder), {
        customerName: editForm.customerName,
        customerPhone: editForm.customerPhone,
        customerEmail: editForm.customerEmail,
        'shippingAddress.señas': editForm.address,
        notes: editForm.notes,
        updatedAt: new Date().toISOString(),
      });
      setEditingOrder(null);
    } catch (err) {
      console.error('Error updating order:', err);
      alert('Error al guardar: ' + err.message);
    }
  };

  const paymentStatusColors = {
    pendiente: 'bg-yellow-100 text-yellow-700',
    parcial: 'bg-amber-100 text-amber-800',
    pagado: 'bg-green-100 text-green-700',
    verificando: 'bg-blue-100 text-blue-700',
    verificado: 'bg-green-100 text-green-700',
    rechazado: 'bg-red-100 text-red-700',
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Confirm Delete Modal */}
      <ConfirmDialog
        isOpen={confirmDelete.isOpen}
        title={confirmDelete.title}
        message={confirmDelete.message}
        onConfirm={confirmDelete.onConfirm}
        onClose={() => setConfirmDelete({ isOpen: false, title: '', message: '', onConfirm: null })}
      />
      <ConfirmDialog
        isOpen={!!cashConfirmation}
        title={cashConfirmation?.action === 'confirm_payment' ? 'Confirmar efectivo recibido' : 'Cancelar pedido contra entrega'}
        message={cashConfirmation ? (cashConfirmation.action === 'confirm_payment'
          ? `¿Confirmás que ya recibiste ${formatCRC(getOrderTotal(cashConfirmation.order))} en efectivo por el pedido ${cashConfirmation.order.orderNumber}? El pago se registrará como cobrado.`
          : `¿Cancelar el pedido ${cashConfirmation.order.orderNumber}? Cancelá solo si los productos siguen en la tienda o ya fueron devueltos; volverán a estar disponibles para la venta. Se liberará el stock reservado y no se registrará un pago.`) : ''}
        onConfirm={() => cashConfirmation && handleCashAction(cashConfirmation.order, cashConfirmation.action)}
        onClose={() => setCashConfirmation(null)}
      />

      {/* Proof Modal */}
      {proofModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setProofModal(null)}>
          <div className="max-w-2xl max-h-[90vh] bg-white rounded-2xl overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="p-3 border-b flex items-center justify-between">
              <span className="text-sm font-bold text-slate-700">Comprobante de Pago</span>
              <button onClick={() => setProofModal(null)} className="text-slate-400 hover:text-slate-600 text-lg font-bold">×</button>
            </div>
            <img src={proofModal} alt="Comprobante" className="max-h-[80vh] w-auto" />
          </div>
        </div>
      )}

      {/* Edit Order Modal */}
      {editingOrder && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setEditingOrder(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between">
              <span className="text-sm font-bold text-slate-700">Editar Pedido</span>
              <button onClick={() => setEditingOrder(null)} className="text-slate-400 hover:text-slate-600 text-lg font-bold">×</button>
            </div>
            <div className="p-4 space-y-3">
              {[{label: 'Nombre', key: 'customerName'}, {label: 'Teléfono', key: 'customerPhone'}, {label: 'Email', key: 'customerEmail'}, {label: 'Dirección/Señas', key: 'address'}].map(f => (
                <div key={f.key}>
                  <label className="text-xs font-bold text-slate-500 block mb-1">{f.label}</label>
                  <input
                    value={editForm[f.key] || ''}
                    onChange={e => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              ))}
              <div>
                <label className="text-xs font-bold text-slate-500 block mb-1">Notas internas</label>
                <textarea
                  value={editForm.notes || ''}
                  onChange={e => setEditForm(prev => ({ ...prev, notes: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                />
              </div>
            </div>
            <div className="p-4 border-t flex justify-end gap-2">
              <button onClick={() => setEditingOrder(null)} className="px-4 py-2 text-sm text-slate-500 hover:bg-slate-100 rounded-xl">Cancelar</button>
              <button onClick={handleSaveEdit} className="px-4 py-2 text-sm bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700">Guardar</button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
        <h2 className="font-black text-2xl text-slate-800 tracking-tight">Pedidos</h2>
        <p className="text-sm text-slate-400 mt-1">{orders.length} pedido{orders.length !== 1 ? 's' : ''} totales</p>
      </div>

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

      {filteredOrders.length > 0 ? (
        <div className="space-y-3">
          {filteredOrders.map(order => {
            const isExpanded = expandedOrder === order.id;
            const addr = order.shippingAddress || {};
            const items = getOrderItems(order);
            const total = getOrderTotal(order);
            const itemCount = order.itemCount || items.length;
            const ocr = order.ocrData || {};
            const gmail = order.gmailVerification || {};
            const isCashOnDelivery = order.paymentMethod === 'contra_entrega';
            const canConfirmCash = isCashOnDelivery && order.paymentStatus === 'pendiente' && order.status !== 'cancelado';
            const cashBusy = cashAction.pending && cashAction.orderId === order.id;
            const statusBusy = statusAction.pending && statusAction.orderId === order.id;
            const visibleStatusFlow = isCashOnDelivery ? cashStatusOptions(order) : STATUS_FLOW;

            return (
              <div key={order.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                <div className="flex flex-wrap items-center gap-4 p-5 cursor-pointer hover:bg-slate-50 transition-colors" data-testid={`order-summary-${order.id}`} onClick={() => toggleExpand(order.id)}>
                  <button className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}><ChevronDown className="w-4 h-4 text-slate-400" /></button>
                  <div className="min-w-[100px]">
                    <span className="font-mono font-bold text-indigo-600 text-xs">{order.orderNumber}</span>
                    <p className="text-[10px] text-slate-400 mt-0.5">{formatDateTime(order.createdAt)}</p>
                  </div>
                  <div className="flex-1 min-w-[150px]">
                    <p className="font-bold text-slate-900 text-sm">{order.customerName}</p>
                    <p className="text-[10px] text-slate-400">{order.customerEmail}</p>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-slate-500"><Package className="w-3 h-3" /><span>{itemCount} item{itemCount !== 1 ? 's' : ''}</span></div>
                  {order.paymentProofUrl && <span className="text-[9px] font-bold bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full flex items-center gap-1"><Image className="w-3 h-3" />Comprobante</span>}
                  {order.paymentStatus === 'verificado' && <span className="text-[9px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">✅ Verificado</span>}
                  {order.paymentStatus === 'verificando' && <span className="text-[9px] font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">⏳ Verificando</span>}
                  {order.paymentStatus === 'parcial' && <span className="text-[9px] font-bold bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">Apartado recibido · saldo pendiente</span>}
                  {order.paymentStatus === 'revision_humana' && !isCashOnDelivery && (
                    <span className="text-[9px] font-bold bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                      👁️ SINPE - Revisión
                      <button onClick={e => { e.stopPropagation(); handlePaymentAction(order.id, 'approve'); }} className="ml-1 bg-emerald-500 text-white px-1.5 py-0.5 rounded-full hover:bg-emerald-600 text-[8px]" title="Aprobar pago">✓</button>
                      <button onClick={e => { e.stopPropagation(); handlePaymentAction(order.id, 'reject'); }} className="bg-red-500 text-white px-1.5 py-0.5 rounded-full hover:bg-red-600 text-[8px]" title="Rechazar pago">✗</button>
                    </span>
                  )}
                  {order.paymentStatus === 'rechazado' && <span className="text-[9px] font-bold bg-red-100 text-red-600 px-2 py-0.5 rounded-full">❌ Rechazado</span>}
                  {(order.paymentStatus === 'pendiente' || !order.paymentStatus) && !order.paymentProofUrl && <span className="text-[9px] font-bold bg-red-50 text-red-500 px-2 py-0.5 rounded-full">{isCashOnDelivery ? (order.status === 'cancelado' ? 'Contra entrega · cancelado' : '💵 Contra entrega · pendiente') : '💳 Pago pendiente'}</span>}
                  {isCashOnDelivery && order.paymentStatus === 'pagado' && <span className="text-[9px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">💵 Efectivo recibido</span>}
                  <StatusBadge status={order.status} />
                  <span className="text-sm font-black text-slate-900 min-w-[90px] text-right">{formatCRC(total)}</span>
                  <select aria-label={`Estado del pedido ${order.orderNumber}`} value={order.status} disabled={isCashOnDelivery && (cashAction.pending || statusAction.pending || visibleStatusFlow.length < 2)} onChange={e => { e.stopPropagation(); return handleStatusChange(order.id, e.target.value); }} onClick={e => e.stopPropagation()} className="text-xs px-3 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold disabled:opacity-50">
                    {visibleStatusFlow.map(s => (<option key={s} value={s}>{ORDER_STATUS_LABELS[s]}</option>))}
                  </select>
                  <button onClick={e => { e.stopPropagation(); handleEditOrder(order); }} className="p-2 hover:bg-blue-50 rounded-xl transition-colors" title="Editar pedido">
                    <Edit3 className="w-4 h-4 text-blue-500" />
                  </button>
                  {!isCashOnDelivery && <button onClick={e => { e.stopPropagation(); e.preventDefault(); handleDeleteOrder(order.id, order.orderNumber); }} className="p-2 hover:bg-red-50 rounded-xl transition-colors" title="Eliminar pedido">
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </button>}
                </div>

                {cashBusy && <p role="status" className="px-5 pb-4 text-sm font-bold text-blue-700">{cashAction.action === 'confirm_payment' ? 'Registrando efectivo recibido…' : 'Cancelando pedido y liberando reserva…'}</p>}
                {cashAction.orderId === order.id && cashAction.error && <p role="alert" className="px-5 pb-4 text-sm font-bold text-red-700">{cashAction.error}</p>}
                {statusBusy && <p role="status" className="px-5 pb-4 text-sm font-bold text-blue-700">Actualizando estado del pedido…</p>}
                {statusAction.orderId === order.id && statusAction.error && <p role="alert" className="px-5 pb-4 text-sm font-bold text-red-700">{statusAction.error}</p>}

                {isExpanded && (
                  <div className="border-t border-slate-100 bg-slate-50 p-5 space-y-5 animate-in fade-in duration-200">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      {/* Productos */}
                      <div>
                        <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Productos Comprados</h4>
                        {items.length > 0 ? (
                          <div className="space-y-2">
                            {items.map((item, idx) => (
                              <div key={idx} className="bg-white rounded-xl p-3 border border-slate-200 flex items-center gap-3">
                                <div className="w-12 h-12 rounded-lg bg-slate-50 border border-slate-200 overflow-hidden shrink-0">
                                  {item.imageUrl ? <img src={item.imageUrl} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center"><Package className="w-5 h-5 text-slate-200" /></div>}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-bold text-slate-900 truncate">{item.productName}</p>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-[10px] text-slate-400">{item.variantName}</span>
                                    <span className="text-[10px] text-slate-400">× {item.quantity}</span>
                                    {item.supplyType === 'bajo_pedido' && <span className="text-[9px] font-bold bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded">BAJO PEDIDO</span>}
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
                            <div className="animate-spin w-3 h-3 border-2 border-slate-300 border-t-indigo-500 rounded-full" />Cargando...
                          </div>
                        )}
                        <div className="mt-3 bg-white rounded-xl p-3 border border-slate-200 space-y-1 text-sm">
                          <div className="flex justify-between"><span className="text-slate-400">Subtotal</span><span>{formatCRC(order.subtotal || order.depositTotal || 0)}</span></div>
                          <div className="flex justify-between"><span className="text-slate-400">Envío ({order.shippingType || 'normal'})</span><span>{formatCRC(order.shippingCost || 0)}</span></div>
                          <div className="flex justify-between font-black text-slate-900 pt-1 border-t"><span>Total</span><span>{formatCRC(total)}</span></div>
                          {order.paymentStatus === 'parcial' && <>
                            <div className="flex justify-between text-emerald-700"><span>Pago recibido</span><span className="font-bold">{formatCRC(order.paymentAmount || 0)}</span></div>
                            <div className="flex justify-between text-amber-800"><span>Saldo pendiente</span><span className="font-bold">{formatCRC(order.remainingTotal || 0)}</span></div>
                          </>}
                        </div>
                      </div>

                      <div className="space-y-4">
                        {/* Verificación de Pago */}
                        <div>
                          <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Verificación de Pago</h4>
                          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                            <div className="p-4 flex items-center justify-between border-b border-slate-100">
                              <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full uppercase ${paymentStatusColors[order.paymentStatus] || paymentStatusColors.pendiente}`}>
                                {order.paymentStatus === 'parcial' ? 'Apartado recibido · saldo pendiente' : (order.paymentStatus || 'pendiente')}
                              </span>
                              {canConfirmCash && (
                                <button type="button" onClick={() => openCashConfirmation(order, 'confirm_payment')} disabled={cashAction.pending || statusAction.pending} className="flex items-center gap-1 text-xs font-bold bg-green-600 text-white px-3 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50">
                                  <CheckCircle className="w-3 h-3" /> {cashBusy ? 'Registrando…' : 'Confirmar efectivo recibido'}
                                </button>
                              )}
                              {order.paymentStatus === 'verificando' && !isCashOnDelivery && order.paymentMethod !== 'paypal' && !order.paypal && (
                                <div className="flex gap-2">
                                  <button onClick={() => handleApprovePayment(order.id)} className="flex items-center gap-1 text-[10px] font-bold bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700 transition-colors">
                                    <CheckCircle className="w-3 h-3" /> Aprobar
                                  </button>
                                  <button onClick={() => handleRejectPayment(order.id)} className="flex items-center gap-1 text-[10px] font-bold bg-red-50 text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-100 transition-colors">
                                    <XCircle className="w-3 h-3" /> Rechazar
                                  </button>
                                </div>
                              )}
                              {order.paymentStatus === 'verificado' && (
                                <span className="text-[10px] text-green-600 font-bold flex items-center gap-1">
                                  <CheckCircle className="w-3 h-3" />
                                  {gmail.verifiedAt ? `Gmail ${formatDateTime(gmail.verifiedAt)}` : order.verifiedBy === 'admin_manual' ? 'Aprobado manualmente' : 'Verificado'}
                                </span>
                              )}
                            </div>

                            {order.paymentMethod === 'contra_entrega' ? (
                              <div className="p-4 border-b border-slate-100 text-sm text-blue-900 bg-blue-50" data-testid="admin-cash-on-delivery">
                                {order.status === 'cancelado'
                                  ? 'Pedido contra entrega cancelado.'
                                  : ['pagado', 'verificado'].includes(order.paymentStatus)
                                    ? 'Pago en efectivo registrado.'
                                    : <>Cobrar <strong>{formatCRC(total)}</strong> en efectivo al entregar. Este pedido no requiere adelanto ni comprobante de transferencia.</>}
                              </div>
                            ) : order.paymentProofUrl ? (
                              <div className="p-4 border-b border-slate-100">
                                <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Comprobante WhatsApp</p>
                                <div className="flex items-start gap-3">
                                  <img src={order.paymentProofUrl} alt="Comprobante" className="w-20 h-20 object-cover rounded-lg border cursor-pointer hover:opacity-80 transition-opacity" onClick={() => setProofModal(order.paymentProofUrl)} />
                                  <div className="flex-1 text-xs space-y-1">
                                    <button onClick={() => setProofModal(order.paymentProofUrl)} className="flex items-center gap-1 text-indigo-600 font-bold hover:underline">
                                      <Eye className="w-3 h-3" /> Ver completo
                                    </button>
                                    {order.proofReceivedAt && <p className="text-slate-400">Recibido: {formatDateTime(order.proofReceivedAt)}</p>}
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className="p-4 border-b border-slate-100 text-xs text-slate-400">Sin comprobante recibido</div>
                            )}

                            {(ocr.amount || ocr.transactionId || ocr.phone) && (
                              <div className="p-4 border-b border-slate-100">
                                <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Datos Extraídos (OCR)</p>
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                  {ocr.amount && <div><span className="text-slate-400">Monto:</span> <span className="font-bold text-slate-700">{formatCRC(ocr.amount)}</span></div>}
                                  {ocr.transactionId && <div><span className="text-slate-400"># Trans:</span> <span className="font-mono font-bold text-slate-700">{ocr.transactionId}</span></div>}
                                  {ocr.phone && <div><span className="text-slate-400">Tel:</span> <span className="font-bold text-slate-700">{ocr.phone}</span></div>}
                                  {ocr.bank && <div><span className="text-slate-400">Banco:</span> <span className="font-bold text-slate-700">{ocr.bank}</span></div>}
                                </div>
                              </div>
                            )}

                            {gmail.emailSubject && (
                              <div className="p-4">
                                <p className="text-[10px] font-bold text-green-600 uppercase mb-1">✅ Verificado vía Gmail</p>
                                <p className="text-xs text-slate-500">{gmail.emailSubject}</p>
                                {gmail.emailAmount && <p className="text-xs text-slate-700 font-bold">Monto: {formatCRC(gmail.emailAmount)}</p>}
                              </div>
                            )}
                          </div>
                        </div>

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
                                <div className="pl-6"><p className="text-xs text-slate-600 bg-slate-50 rounded-lg p-2">{addr.señas || addr.senas || 'Sin señas'}</p></div>
                              </>
                            ) : <p className="text-xs text-slate-400">Sin dirección registrada</p>}
                          </div>
                        </div>

                        <div>
                          {order.customerNotes && (
                            <section className="mb-4" aria-label="Notas del cliente">
                              <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Notas del cliente</h4>
                              <p className="bg-white rounded-xl p-4 border border-slate-200 text-sm text-slate-700 whitespace-pre-wrap break-words">{order.customerNotes}</p>
                            </section>
                          )}
                          <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Datos del Cliente</h4>
                          <div className="bg-white rounded-xl p-4 border border-slate-200 space-y-2">
                            <div className="flex items-center gap-2"><Phone className="w-3.5 h-3.5 text-slate-400" /><span className="text-sm text-slate-700">{order.customerPhone || 'Sin teléfono'}</span></div>
                            <div className="text-xs text-slate-400">
                              <p>Pago: <span className="font-bold text-slate-600">{PAYMENT_METHOD_LABELS[order.paymentMethod] || order.paymentMethod?.replaceAll('_', ' ')}</span></p>
                              {order.paymentPhone && <p>Tel. SINPE: <span className="font-bold text-slate-600">{order.paymentPhone}</span></p>}
                            </div>
                          </div>
                        </div>
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
