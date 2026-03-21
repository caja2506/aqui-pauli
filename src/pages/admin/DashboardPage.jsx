import React from 'react';
import { Package, ClipboardList, Users, DollarSign, TrendingUp, ShoppingCart } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { formatCRC } from '../../utils/formatters';

export default function DashboardPage() {
  const { data: products } = useCollection('products');
  const { data: orders } = useCollection('orders');
  const { data: brands } = useCollection('brands');
  const { data: categories } = useCollection('categories');

  const activeProducts = products.filter(p => p.active && !p.deleted);
  const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
  const pendingOrders = orders.filter(o => ['pendiente_pago', 'revision_manual', 'por_preparar', 'preparando'].includes(o.status));

  const stats = [
    { icon: Package, label: 'Productos Activos', value: activeProducts.length, color: 'indigo' },
    { icon: ClipboardList, label: 'Pedidos Pendientes', value: pendingOrders.length, color: 'amber' },
    { icon: DollarSign, label: 'Ingresos Totales', value: formatCRC(totalRevenue), color: 'green' },
    { icon: ShoppingCart, label: 'Total Pedidos', value: orders.length, color: 'purple' },
    { icon: TrendingUp, label: 'Marcas', value: brands.length, color: 'blue' },
    { icon: Users, label: 'Categorías', value: categories.length, color: 'pink' },
  ];

  const colorClasses = {
    indigo: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    amber: 'bg-amber-50 text-amber-600 border-amber-100',
    green: 'bg-green-50 text-green-600 border-green-100',
    purple: 'bg-purple-50 text-purple-600 border-purple-100',
    blue: 'bg-blue-50 text-blue-600 border-blue-100',
    pink: 'bg-pink-50 text-pink-600 border-pink-100',
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
        <h2 className="font-black text-2xl text-slate-800 tracking-tight">Dashboard</h2>
        <p className="text-sm text-slate-400 mt-1">Resumen general de la tienda</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {stats.map((stat, i) => (
          <div key={i} className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex items-center gap-4">
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center border ${colorClasses[stat.color]}`}>
              <stat.icon className="w-7 h-7" />
            </div>
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{stat.label}</p>
              <p className="text-2xl font-black text-slate-900 tracking-tight mt-0.5">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Recent Orders */}
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <h3 className="font-black text-lg text-slate-800">Pedidos Recientes</h3>
        </div>
        {orders.length > 0 ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest">
              <tr>
                <th className="p-4"># Orden</th>
                <th className="p-4">Cliente</th>
                <th className="p-4">Estado</th>
                <th className="p-4 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {orders.slice(0, 5).map(order => (
                <tr key={order.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-4 font-mono font-bold text-indigo-600 text-xs">{order.orderNumber}</td>
                  <td className="p-4 text-slate-700">{order.customerName}</td>
                  <td className="p-4">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">{order.status?.replace(/_/g, ' ')}</span>
                  </td>
                  <td className="p-4 text-right font-black text-slate-900">{formatCRC(order.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-8 text-center text-sm text-slate-400">Aún no hay pedidos</div>
        )}
      </div>
    </div>
  );
}
