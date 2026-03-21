import React, { useState } from 'react';
import { Search, ClipboardList } from 'lucide-react';
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

  const filteredOrders = orders.filter(o => {
    const s = search.toLowerCase();
    const matchesSearch = !s || (o.orderNumber || '').toLowerCase().includes(s) || (o.customerName || '').toLowerCase().includes(s) || (o.customerEmail || '').toLowerCase().includes(s);
    const matchesStatus = !statusFilter || o.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleStatusChange = async (orderId, newStatus) => {
    await updateOrderStatus(orderId, newStatus);
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

      {/* Orders Table */}
      {filteredOrders.length > 0 ? (
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b text-[10px] font-black text-slate-400 uppercase tracking-widest">
              <tr>
                <th className="p-5"># Orden</th>
                <th className="p-5">Cliente</th>
                <th className="p-5">Fecha</th>
                <th className="p-5 text-center">Estado</th>
                <th className="p-5">Pago</th>
                <th className="p-5 text-right">Total</th>
                <th className="p-5 text-center">Cambiar Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredOrders.map(order => (
                <tr key={order.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-5 font-mono font-bold text-indigo-600 text-xs">{order.orderNumber}</td>
                  <td className="p-5">
                    <div className="text-slate-900 font-bold">{order.customerName}</div>
                    <div className="text-[10px] text-slate-400">{order.customerEmail}</div>
                  </td>
                  <td className="p-5 text-xs text-slate-500">{formatDateTime(order.createdAt)}</td>
                  <td className="p-5 text-center"><StatusBadge status={order.status} /></td>
                  <td className="p-5 text-xs text-slate-500 capitalize">{order.paymentMethod?.replace('_', ' ')}</td>
                  <td className="p-5 text-right font-black text-slate-900">{formatCRC(order.total)}</td>
                  <td className="p-5 text-center">
                    <select
                      value={order.status}
                      onChange={e => handleStatusChange(order.id, e.target.value)}
                      className="text-xs px-3 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold"
                    >
                      {STATUS_FLOW.map(s => (
                        <option key={s} value={s}>{ORDER_STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={ClipboardList} title="Sin pedidos" message="Los pedidos aparecerán aquí cuando los clientes compren" />
      )}
    </div>
  );
}
