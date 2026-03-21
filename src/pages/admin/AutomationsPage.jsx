import { Zap, ShoppingCart, Truck, Star, MessageCircle, Bell, AlertCircle, CheckCircle } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { formatDateTime } from '../../utils/formatters';

const TYPE_LABELS = {
  carrito_abandonado: { label: 'Carrito Abandonado', icon: ShoppingCart, color: 'amber' },
  tracking_update: { label: 'Tracking Postventa', icon: Truck, color: 'blue' },
  review_request: { label: 'Solicitud de Reseña', icon: Star, color: 'rose' },
  backorder_payment: { label: 'Cobro Bajo Pedido', icon: Bell, color: 'green' },
};

const STATUS_COLORS = {
  pending: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  processing: 'bg-blue-100 text-blue-700 border-blue-200',
  sent: 'bg-green-100 text-green-700 border-green-200',
  stub_logged: 'bg-slate-100 text-slate-600 border-slate-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200',
};

const STATUS_ICONS = {
  pending: Zap,
  processing: Zap,
  sent: CheckCircle,
  failed: AlertCircle,
  cancelled: AlertCircle,
};

export default function AutomationsPage() {
  const { data: automations } = useCollection('automations', { orderByField: 'createdAt', orderDirection: 'desc' });

  const pendingCount = automations.filter(a => a.status === 'pending').length;
  const failedCount = automations.filter(a => a.status === 'failed').length;
  const sentCount = automations.filter(a => a.status === 'sent').length;

  const automationTypes = [
    {
      key: 'carrito_abandonado',
      title: 'Carrito Abandonado',
      description: 'WhatsApp al día siguiente si el cliente no completó la compra',
      icon: ShoppingCart,
    },
    {
      key: 'tracking_update',
      title: 'Tracking Postventa',
      description: 'Notificación con actualización de estado del pedido',
      icon: Truck,
    },
    {
      key: 'review_request',
      title: 'Solicitud de Reseña',
      description: 'Mensaje solicitando reseña post-entrega',
      icon: Star,
    },
    {
      key: 'backorder_payment',
      title: 'Cobro Bajo Pedido',
      description: 'Cobro del 80% restante cuando producto está listo',
      icon: Bell,
    },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
        <h2 className="font-black text-2xl text-slate-800 tracking-tight">Automatizaciones</h2>
        <p className="text-sm text-slate-400 mt-1">Motor de automatizaciones y registro de ejecuciones</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center">
          <div className="text-2xl font-black text-amber-700">{pendingCount}</div>
          <div className="text-[10px] font-bold text-amber-500 uppercase">Pendientes</div>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-2xl p-4 text-center">
          <div className="text-2xl font-black text-green-700">{sentCount}</div>
          <div className="text-[10px] font-bold text-green-500 uppercase">Enviadas</div>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-center">
          <div className="text-2xl font-black text-red-700">{failedCount}</div>
          <div className="text-[10px] font-bold text-red-500 uppercase">Fallidas</div>
        </div>
      </div>

      {/* Automation Types */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {automationTypes.map(auto => {
          const count = automations.filter(a => a.type === auto.key).length;
          return (
            <div key={auto.key} className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl bg-rose-50 flex items-center justify-center shrink-0">
                <auto.icon className="w-5 h-5 text-rose-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-bold text-sm text-slate-900">{auto.title}</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">{auto.description}</p>
                <div className="text-[10px] font-bold text-slate-500 mt-1">{count} registros</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Execution Log */}
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-slate-100">
          <h3 className="font-black text-lg text-slate-800">Registro de Ejecuciones</h3>
        </div>
        {automations.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest">
                <tr>
                  <th className="p-4">Tipo</th>
                  <th className="p-4">Destinatario</th>
                  <th className="p-4">Canal</th>
                  <th className="p-4 text-center">Estado</th>
                  <th className="p-4 text-center">Intentos</th>
                  <th className="p-4">Programado</th>
                  <th className="p-4">Ejecutado</th>
                  <th className="p-4">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {automations.map(auto => {
                  const typeInfo = TYPE_LABELS[auto.type] || { label: auto.type, icon: Zap, color: 'slate' };
                  const StatusIcon = STATUS_ICONS[auto.status] || Zap;
                  return (
                    <tr key={auto.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-4 text-xs font-bold text-slate-700">{typeInfo.label}</td>
                      <td className="p-4 text-xs text-slate-500">{auto.targetContact || auto.metadata?.customerName || auto.targetUid?.slice(0, 8) || '—'}</td>
                      <td className="p-4">
                        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                          <MessageCircle className="w-3 h-3" /> {auto.channel}
                        </span>
                      </td>
                      <td className="p-4 text-center">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${STATUS_COLORS[auto.status] || STATUS_COLORS.pending}`}>
                          <StatusIcon className="w-3 h-3" />
                          {auto.status}
                        </span>
                      </td>
                      <td className="p-4 text-center text-xs font-bold text-slate-600">{auto.attemptCount || 0}</td>
                      <td className="p-4 text-[10px] text-slate-400">{formatDateTime(auto.scheduledAt)}</td>
                      <td className="p-4 text-[10px] text-slate-400">{formatDateTime(auto.executedAt)}</td>
                      <td className="p-4 text-[10px] text-red-400 max-w-[120px] truncate">{auto.errorMessage || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center text-sm text-slate-400">
            No hay ejecuciones registradas aún. Las automatizaciones se activarán con las primeras compras.
          </div>
        )}
      </div>
    </div>
  );
}
