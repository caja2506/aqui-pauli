import React, { useState } from 'react';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { db, functions } from '../../firebase';
import { httpsCallable } from 'firebase/functions';
import { Search, ClipboardList, ChevronDown, MapPin, Package, Phone, Image, CheckCircle, XCircle, Eye, Trash2, Edit3 } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { updateOrderStatus } from '../../services/orderService';
import { formatCRC, formatDateTime } from '../../utils/formatters';
import { ORDER_STATUS_LABELS, ORDER_STATUS } from '../../utils/constants';
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

export default function OrdersPage() {
  const { data: orders, loading } = useCollection('orders', { orderByField: 'createdAt', orderDirection: 'desc' });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [loadedItems, setLoadedItems] = useState({});
  const [proofModal, setProofModal] = useState(null);
  const [editingOrder, setEditingOrder] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState({ isOpen: false, title: '', message: '', onConfirm: null });

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

  const handleStatusChange = async (orderId, newStatus) => {
    await updateOrderStatus(orderId, newStatus);
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
                <label className="text-xs font-bold text-slate-500 block mb-1">Notas</label>
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

            return (
              <div key={order.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                <div className="flex flex-wrap items-center gap-4 p-5 cursor-pointer hover:bg-slate-50 transition-colors" onClick={() => toggleExpand(order.id)}>
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
                  {order.paymentStatus === 'revision_humana' && (
                    <span className="text-[9px] font-bold bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                      👁️ SINPE - Revisión
                      <button onClick={e => { e.stopPropagation(); handlePaymentAction(order.id, 'approve'); }} className="ml-1 bg-emerald-500 text-white px-1.5 py-0.5 rounded-full hover:bg-emerald-600 text-[8px]" title="Aprobar pago">✓</button>
                      <button onClick={e => { e.stopPropagation(); handlePaymentAction(order.id, 'reject'); }} className="bg-red-500 text-white px-1.5 py-0.5 rounded-full hover:bg-red-600 text-[8px]" title="Rechazar pago">✗</button>
                    </span>
                  )}
                  {order.paymentStatus === 'rechazado' && <span className="text-[9px] font-bold bg-red-100 text-red-600 px-2 py-0.5 rounded-full">❌ Rechazado</span>}
                  {(order.paymentStatus === 'pendiente' || !order.paymentStatus) && !order.paymentProofUrl && <span className="text-[9px] font-bold bg-red-50 text-red-500 px-2 py-0.5 rounded-full">💳 Pago pendiente</span>}
                  <StatusBadge status={order.status} />
                  <span className="text-sm font-black text-slate-900 min-w-[90px] text-right">{formatCRC(total)}</span>
                  <select value={order.status} onChange={e => { e.stopPropagation(); handleStatusChange(order.id, e.target.value); }} onClick={e => e.stopPropagation()} className="text-xs px-3 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold">
                    {STATUS_FLOW.map(s => (<option key={s} value={s}>{ORDER_STATUS_LABELS[s]}</option>))}
                  </select>
                  <button onClick={e => { e.stopPropagation(); handleEditOrder(order); }} className="p-2 hover:bg-blue-50 rounded-xl transition-colors" title="Editar pedido">
                    <Edit3 className="w-4 h-4 text-blue-500" />
                  </button>
                  <button onClick={e => { e.stopPropagation(); e.preventDefault(); handleDeleteOrder(order.id, order.orderNumber); }} className="p-2 hover:bg-red-50 rounded-xl transition-colors" title="Eliminar pedido">
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </button>
                </div>

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
                        </div>
                      </div>

                      <div className="space-y-4">
                        {/* Verificación de Pago */}
                        <div>
                          <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Verificación de Pago</h4>
                          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                            <div className="p-4 flex items-center justify-between border-b border-slate-100">
                              <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full uppercase ${paymentStatusColors[order.paymentStatus] || paymentStatusColors.pendiente}`}>
                                {order.paymentStatus || 'pendiente'}
                              </span>
                              {order.paymentStatus === 'verificando' && (
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

                            {order.paymentProofUrl ? (
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
                          <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Datos del Cliente</h4>
                          <div className="bg-white rounded-xl p-4 border border-slate-200 space-y-2">
                            <div className="flex items-center gap-2"><Phone className="w-3.5 h-3.5 text-slate-400" /><span className="text-sm text-slate-700">{order.customerPhone || 'Sin teléfono'}</span></div>
                            <div className="text-xs text-slate-400">
                              <p>Pago: <span className="font-bold text-slate-600 capitalize">{order.paymentMethod?.replace('_', ' ')}</span></p>
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
