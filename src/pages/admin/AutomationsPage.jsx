import React from 'react';
import { Zap, ShoppingCart, Truck, Star, MessageCircle, Bell } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import EmptyState from '../../components/ui/EmptyState';
import { formatDateTime } from '../../utils/formatters';

const TYPE_LABELS = {
  abandoned_cart: { label: 'Carrito Abandonado', icon: ShoppingCart, color: 'amber' },
  post_sale_tracking: { label: 'Tracking Postventa', icon: Truck, color: 'blue' },
  post_sale_review: { label: 'Solicitud de Reseña', icon: Star, color: 'purple' },
  backorder_payment: { label: 'Cobro Bajo Pedido', icon: Bell, color: 'green' },
};

const STATUS_COLORS = {
  pending: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  sent: 'bg-blue-100 text-blue-700 border-blue-200',
  completed: 'bg-green-100 text-green-700 border-green-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
};

export default function AutomationsPage() {
  const { data: automations } = useCollection('automations', { orderByField: 'scheduledAt', orderDirection: 'desc' });

  const automationTypes = [
    {
      key: 'abandoned_cart',
      title: 'Carrito Abandonado',
      description: 'Envío automático por WhatsApp al día siguiente si el cliente no completó la compra',
      icon: ShoppingCart,
      status: 'Activo — 1 intento, al día siguiente',
    },
    {
      key: 'post_sale_tracking',
      title: 'Tracking Postventa',
      description: 'Notificación automática con número de guía cuando el pedido se marca como enviado',
      icon: Truck,
      status: 'Activo — al cambiar estado a "enviado"',
    },
    {
      key: 'post_sale_review',
      title: 'Solicitud de Reseña',
      description: 'Mensaje automático solicitando reseña después de la entrega, redirige a enlace externo',
      icon: Star,
      status: 'Activo — post-entrega',
    },
    {
      key: 'backorder_payment',
      title: 'Cobro 80% Bajo Pedido',
      description: 'Solicitud automática del 80% restante por WhatsApp cuando el producto está listo',
      icon: Bell,
      status: 'Activo — cuando producto bajo pedido llega',
    },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
        <h2 className="font-black text-2xl text-slate-800 tracking-tight">Automatizaciones</h2>
        <p className="text-sm text-slate-400 mt-1">Automatizaciones activas y registro de ejecuciones</p>
      </div>

      {/* Automation Types */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {automationTypes.map(auto => (
          <div key={auto.key} className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0">
              <auto.icon className="w-6 h-6 text-indigo-600" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900">{auto.title}</h3>
              <p className="text-xs text-slate-400 mt-1">{auto.description}</p>
              <div className="flex items-center gap-1 mt-2">
                <Zap className="w-3 h-3 text-green-500" />
                <span className="text-[10px] font-bold text-green-600">{auto.status}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Execution Log */}
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <h3 className="font-black text-lg text-slate-800">Registro de Ejecuciones</h3>
        </div>
        {automations.length > 0 ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest">
              <tr>
                <th className="p-4">Tipo</th>
                <th className="p-4">Canal</th>
                <th className="p-4 text-center">Estado</th>
                <th className="p-4">Programado</th>
                <th className="p-4">Ejecutado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {automations.map(auto => {
                const typeInfo = TYPE_LABELS[auto.type] || { label: auto.type, icon: Zap, color: 'slate' };
                return (
                  <tr key={auto.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4 text-xs font-bold text-slate-700">{typeInfo.label}</td>
                    <td className="p-4">
                      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                        <MessageCircle className="w-3 h-3" /> {auto.channel}
                      </span>
                    </td>
                    <td className="p-4 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${STATUS_COLORS[auto.status] || STATUS_COLORS.pending}`}>
                        {auto.status}
                      </span>
                    </td>
                    <td className="p-4 text-xs text-slate-400">{formatDateTime(auto.scheduledAt)}</td>
                    <td className="p-4 text-xs text-slate-400">{formatDateTime(auto.executedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="p-8 text-center text-sm text-slate-400">
            No hay ejecuciones registradas aún. Las automatizaciones se activarán con las primeras compras.
          </div>
        )}
      </div>
    </div>
  );
}
