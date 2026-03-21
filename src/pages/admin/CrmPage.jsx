import React from 'react';
import { Users, UserPlus, ShoppingCart, Repeat, Frown } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { CRM_FUNNEL_STAGES } from '../../utils/constants';
import { formatCRC, formatDate } from '../../utils/formatters';
import EmptyState from '../../components/ui/EmptyState';

const funnelIcons = { visitante: Users, interesado: UserPlus, carrito: ShoppingCart, comprador: ShoppingCart, recurrente: Repeat, inactivo: Frown };
const funnelColors = {
  visitante: 'bg-slate-100 text-slate-700 border-slate-200',
  interesado: 'bg-blue-100 text-blue-700 border-blue-200',
  carrito: 'bg-amber-100 text-amber-700 border-amber-200',
  comprador: 'bg-green-100 text-green-700 border-green-200',
  recurrente: 'bg-purple-100 text-purple-700 border-purple-200',
  inactivo: 'bg-red-100 text-red-700 border-red-200',
};

export default function CrmPage() {
  const { data: contacts, loading } = useCollection('crm_contacts');

  const stageCount = CRM_FUNNEL_STAGES.map(stage => ({
    ...stage,
    count: contacts.filter(c => c.funnelStage === stage.key).length,
  }));

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
        <h2 className="font-black text-2xl text-slate-800 tracking-tight">CRM</h2>
        <p className="text-sm text-slate-400 mt-1">Gestión de clientes y embudo de ventas</p>
      </div>

      {/* Funnel */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {stageCount.map(stage => {
          const Icon = funnelIcons[stage.key] || Users;
          return (
            <div key={stage.key} className={`p-4 rounded-2xl border text-center ${funnelColors[stage.key]}`}>
              <Icon className="w-6 h-6 mx-auto mb-2 opacity-60" />
              <div className="text-2xl font-black">{stage.count}</div>
              <div className="text-[10px] font-bold uppercase tracking-widest mt-1">{stage.label}</div>
            </div>
          );
        })}
      </div>

      {/* Contacts */}
      {contacts.length > 0 ? (
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b text-[10px] font-black text-slate-400 uppercase tracking-widest">
              <tr>
                <th className="p-5">Cliente</th>
                <th className="p-5">Teléfono</th>
                <th className="p-5 text-center">Etapa</th>
                <th className="p-5 text-center">Pedidos</th>
                <th className="p-5 text-right">Total Gastado</th>
                <th className="p-5">Último Pedido</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {contacts.map(contact => (
                <tr key={contact.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-5">
                    <div className="font-bold text-slate-900">{contact.displayName}</div>
                    <div className="text-[10px] text-slate-400">{contact.email}</div>
                  </td>
                  <td className="p-5 text-xs text-slate-500">{contact.phone || '—'}</td>
                  <td className="p-5 text-center">
                    <span className={`inline-flex px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider border ${funnelColors[contact.funnelStage] || funnelColors.visitante}`}>
                      {CRM_FUNNEL_STAGES.find(s => s.key === contact.funnelStage)?.label || contact.funnelStage}
                    </span>
                  </td>
                  <td className="p-5 text-center font-bold text-slate-700">{contact.totalOrders || 0}</td>
                  <td className="p-5 text-right font-black text-slate-900">{formatCRC(contact.totalSpent || 0)}</td>
                  <td className="p-5 text-xs text-slate-500">{formatDate(contact.lastOrderDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={Users}
          title="CRM vacío"
          message="Los contactos se crearán automáticamente cuando los clientes se registren o compren. También puedes agregarlos manualmente."
        />
      )}
    </div>
  );
}
