import { useState } from 'react';
import { Users, UserPlus, ShoppingCart, Repeat, Frown, AlertCircle, ChevronDown, ChevronRight, MessageCircle, Brain, Tag } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { CRM_FUNNEL_STAGES } from '../../utils/constants';
import { formatCRC, formatDate, formatDateTime } from '../../utils/formatters';
import EmptyState from '../../components/ui/EmptyState';
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../../firebase';

const funnelIcons = { visitante: Users, interesado: UserPlus, carrito: ShoppingCart, comprador_potencial: Tag, comprador: ShoppingCart, recurrente: Repeat, inactivo: Frown };
const funnelColors = {
  visitante: 'bg-slate-100 text-slate-700 border-slate-200',
  interesado: 'bg-blue-100 text-blue-700 border-blue-200',
  carrito: 'bg-amber-100 text-amber-700 border-amber-200',
  comprador_potencial: 'bg-orange-100 text-orange-700 border-orange-200',
  comprador: 'bg-green-100 text-green-700 border-green-200',
  recurrente: 'bg-rose-100 text-rose-700 border-rose-200',
  inactivo: 'bg-red-100 text-red-700 border-red-200',
};

const STAGES_EXTENDED = [
  ...CRM_FUNNEL_STAGES,
  ...(CRM_FUNNEL_STAGES.find(s => s.key === 'comprador_potencial') ? [] : [{ key: 'comprador_potencial', label: 'Comprador Potencial' }]),
];

export default function CrmPage() {
  const { data: contacts, loading } = useCollection('crm_contacts');
  const [expanded, setExpanded] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const stageCount = STAGES_EXTENDED.map(stage => ({
    ...stage,
    count: contacts.filter(c => c.funnelStage === stage.key).length,
  }));

  const unresolvedCount = contacts.filter(c => c.unresolvedAttentionRequired).length;

  const toggleExpand = async (contactId) => {
    if (expanded === contactId) {
      setExpanded(null);
      setMessages([]);
      return;
    }

    setExpanded(contactId);
    setLoadingMessages(true);

    try {
      const msgsRef = collection(db, 'crm_contacts', contactId, 'messages');
      const q = query(msgsRef, orderBy('createdAt', 'desc'), limit(20));
      const snap = await getDocs(q);
      setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('Error loading messages:', err);
      setMessages([]);
    }
    setLoadingMessages(false);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex items-center justify-between">
        <div>
          <h2 className="font-black text-2xl text-slate-800 tracking-tight">CRM</h2>
          <p className="text-sm text-slate-400 mt-1">Gestión de clientes y embudo de ventas</p>
        </div>
        {unresolvedCount > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 bg-red-50 border border-red-200 rounded-2xl">
            <AlertCircle className="w-4 h-4 text-red-500" />
            <span className="text-xs font-bold text-red-600">{unresolvedCount} requiere atención</span>
          </div>
        )}
      </div>

      {/* Funnel */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
        {stageCount.map(stage => {
          const Icon = funnelIcons[stage.key] || Users;
          return (
            <div key={stage.key} className={`p-4 rounded-2xl border text-center ${funnelColors[stage.key] || funnelColors.visitante}`}>
              <Icon className="w-5 h-5 mx-auto mb-1 opacity-60" />
              <div className="text-2xl font-black">{stage.count}</div>
              <div className="text-[9px] font-bold uppercase tracking-widest mt-1">{stage.label}</div>
            </div>
          );
        })}
      </div>

      {/* Contacts */}
      {contacts.length > 0 ? (
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b text-[10px] font-black text-slate-400 uppercase tracking-widest">
              <tr>
                <th className="p-4 w-8"></th>
                <th className="p-4">Cliente</th>
                <th className="p-4">Teléfono</th>
                <th className="p-4 text-center">Etapa</th>
                <th className="p-4 text-center">Pedidos</th>
                <th className="p-4 text-right">Total</th>
                <th className="p-4 text-center">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {contacts.map(contact => (
                <>
                  <tr
                    key={contact.id}
                    onClick={() => toggleExpand(contact.id)}
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    <td className="p-4 text-slate-400">
                      {expanded === contact.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </td>
                    <td className="p-4">
                      <div className="font-bold text-slate-900">{contact.displayName || '—'}</div>
                      <div className="text-[10px] text-slate-400">{contact.email}</div>
                    </td>
                    <td className="p-4 text-xs text-slate-500">{contact.phone || '—'}</td>
                    <td className="p-4 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border ${funnelColors[contact.funnelStage] || funnelColors.visitante}`}>
                        {STAGES_EXTENDED.find(s => s.key === contact.funnelStage)?.label || contact.funnelStage}
                      </span>
                    </td>
                    <td className="p-4 text-center font-bold text-slate-700">{contact.totalOrders || 0}</td>
                    <td className="p-4 text-right font-black text-slate-900">{formatCRC(contact.totalSpent || 0)}</td>
                    <td className="p-4 text-center">
                      {contact.unresolvedAttentionRequired ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 border border-red-200 text-red-600 rounded-full text-[10px] font-bold">
                          <AlertCircle className="w-3 h-3" /> Pendiente
                        </span>
                      ) : contact.lastIntent ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 border border-green-200 text-green-600 rounded-full text-[10px] font-bold">
                          <Brain className="w-3 h-3" /> {contact.lastIntent}
                        </span>
                      ) : (
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </td>
                  </tr>

                  {/* Expanded: Messages */}
                  {expanded === contact.id && (
                    <tr key={`${contact.id}-detail`}>
                      <td colSpan={7} className="bg-slate-50 p-0">
                        <div className="p-4 max-h-72 overflow-y-auto">
                          <div className="flex items-center gap-2 mb-3">
                            <MessageCircle className="w-4 h-4 text-slate-500" />
                            <span className="text-xs font-black text-slate-600 uppercase tracking-widest">Mensajes Recientes</span>
                          </div>
                          {loadingMessages ? (
                            <p className="text-xs text-slate-400 animate-pulse">Cargando...</p>
                          ) : messages.length > 0 ? (
                            <div className="space-y-2">
                              {messages.map(msg => (
                                <div
                                  key={msg.id}
                                  className={`p-3 rounded-xl text-xs max-w-[80%] ${
                                    msg.direction === 'inbound'
                                      ? 'bg-white border border-slate-200 mr-auto'
                                      : 'bg-rose-50 border border-rose-200 ml-auto'
                                  }`}
                                >
                                  <div className="font-bold text-slate-600 mb-1">
                                    {msg.direction === 'inbound' ? '📩 Entrante' : '📤 Saliente'}
                                    {msg.autoReply && <span className="text-amber-500 ml-1">🤖 Auto</span>}
                                  </div>
                                  <p className="text-slate-700">{msg.content}</p>
                                  <div className="text-[10px] text-slate-400 mt-1">{formatDateTime(msg.createdAt)}</div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-slate-400">Sin mensajes registrados.</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={Users}
          title="CRM vacío"
          message="Los contactos se crearán automáticamente cuando los clientes se registren o compren."
        />
      )}
    </div>
  );
}
