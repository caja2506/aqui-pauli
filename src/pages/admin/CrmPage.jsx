import { useState } from 'react';
import { Users, UserPlus, ShoppingCart, Repeat, Frown, AlertCircle, ChevronDown, ChevronRight, MessageCircle, Brain, Tag, Save, X, Pencil, MapPin, CreditCard, IdCard, Trash2 } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { CRM_FUNNEL_STAGES } from '../../utils/constants';
import { formatCRC, formatDateTime } from '../../utils/formatters';
import EmptyState from '../../components/ui/EmptyState';
import { collection, getDocs, query, orderBy, limit, doc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../../firebase';
import { getProvincias, getCantones, getDistritos, buscarPorCodigoPostal } from '../../data/costaRicaTerritorial';

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

const InputField = ({ label, value, onChange, placeholder, icon: Icon }) => (
  <div>
    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 flex items-center gap-1">
      {Icon && <Icon className="w-3 h-3" />} {label}
    </label>
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent"
    />
  </div>
);

export default function CrmPage() {
  const { data: contacts, loading } = useCollection('crm_contacts');
  const [expanded, setExpanded] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [stageFilter, setStageFilter] = useState(null); // null = all, 'attention' = requiere atención, or stage key

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

  const startEditing = (contact) => {
    setEditing(contact.id);
    setEditForm({
      displayName: contact.displayName || '',
      cedula: contact.cedula || '',
      email: contact.email || '',
      phone: contact.phone || '',
      funnelStage: contact.funnelStage || 'visitante',
      provincia: contact.lastAddress?.provincia || '',
      canton: contact.lastAddress?.canton || '',
      distrito: contact.lastAddress?.distrito || '',
      codigoPostal: contact.lastAddress?.codigoPostal || '',
      señas: contact.lastAddress?.señas || '',
      preferredPaymentMethod: contact.preferredPaymentMethod || '',
      paymentPhone: contact.paymentPhone || '',
    });
  };

  const saveContact = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, 'crm_contacts', editing), {
        displayName: editForm.displayName,
        cedula: editForm.cedula,
        email: editForm.email,
        phone: editForm.phone,
        funnelStage: editForm.funnelStage,
        lastAddress: {
          provincia: editForm.provincia,
          canton: editForm.canton,
          distrito: editForm.distrito,
          codigoPostal: editForm.codigoPostal,
          señas: editForm.señas,
        },
        preferredPaymentMethod: editForm.preferredPaymentMethod,
        paymentPhone: editForm.paymentPhone,
        updatedAt: new Date().toISOString(),
      });
      setEditing(null);
    } catch (err) {
      console.error('Error saving contact:', err);
    }
    setSaving(false);
  };


  if (loading) return <div className="text-center py-20 text-slate-400 animate-pulse">Cargando CRM...</div>;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex items-center justify-between">
        <div>
          <h2 className="font-black text-2xl text-slate-800 tracking-tight">CRM</h2>
          <p className="text-sm text-slate-400 mt-1">Gestión de clientes y embudo de ventas</p>
        </div>
        {unresolvedCount > 0 && (
          <button
            onClick={() => setStageFilter(f => f === 'attention' ? null : 'attention')}
            className={`flex items-center gap-2 px-4 py-2 border rounded-2xl transition-all cursor-pointer ${
              stageFilter === 'attention'
                ? 'bg-red-500 border-red-600 ring-2 ring-red-300'
                : 'bg-red-50 border-red-200 hover:bg-red-100'
            }`}
          >
            <AlertCircle className={`w-4 h-4 ${stageFilter === 'attention' ? 'text-white' : 'text-red-500'}`} />
            <span className={`text-xs font-bold ${stageFilter === 'attention' ? 'text-white' : 'text-red-600'}`}>{unresolvedCount} requiere atención</span>
          </button>
        )}
      </div>

      {/* Funnel - Clickable Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
        {stageCount.map(stage => {
          const Icon = funnelIcons[stage.key] || Users;
          const isActive = stageFilter === stage.key;
          return (
            <button
              key={stage.key}
              onClick={() => setStageFilter(f => f === stage.key ? null : stage.key)}
              className={`p-4 rounded-2xl border text-center transition-all cursor-pointer ${funnelColors[stage.key] || funnelColors.visitante} ${
                isActive ? 'ring-2 ring-offset-1 ring-slate-800 scale-105 shadow-lg' : 'hover:scale-102 hover:shadow-md'
              } ${stageFilter && !isActive ? 'opacity-40' : ''}`}
            >
              <Icon className="w-5 h-5 mx-auto mb-1 opacity-60" />
              <div className="text-2xl font-black">{stage.count}</div>
              <div className="text-[9px] font-bold uppercase tracking-widest mt-1">{stage.label}</div>
            </button>
          );
        })}
      </div>

      {/* Active Filter Indicator */}
      {stageFilter && (
        <div className="flex items-center gap-2 px-4 py-2 bg-slate-100 rounded-xl">
          <span className="text-xs text-slate-500">Filtrando:</span>
          <span className="text-xs font-bold text-slate-800">
            {stageFilter === 'attention' ? 'Requiere atención' : STAGES_EXTENDED.find(s => s.key === stageFilter)?.label || stageFilter}
          </span>
          <button onClick={() => setStageFilter(null)} className="ml-auto text-xs text-rose-500 font-bold hover:underline">Limpiar filtro</button>
        </div>
      )}

      {/* Contacts */}
      {(() => {
        const filteredContacts = stageFilter === 'attention'
          ? contacts.filter(c => c.unresolvedAttentionRequired)
          : stageFilter
            ? contacts.filter(c => c.funnelStage === stageFilter)
            : contacts;

        return filteredContacts.length > 0 ? (
        <div className="space-y-3">
          {filteredContacts.map(contact => (
            <div key={contact.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              {/* Contact header row */}
              <div
                onClick={() => toggleExpand(contact.id)}
                className="flex items-center gap-4 p-4 hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <div className="text-slate-400">
                  {expanded === contact.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>

                {/* Avatar */}
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-rose-400 to-pink-500 flex items-center justify-center text-white font-black text-sm shrink-0">
                  {(contact.displayName || contact.phone || '?')[0]?.toUpperCase()}
                </div>

                {/* Name & email */}
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-900 truncate">{contact.displayName || contact.phone || '—'}</div>
                  <div className="text-[10px] text-slate-400 truncate">
                    {contact.email || '—'}
                    {contact.cedula && ` · Céd: ${contact.cedula}`}
                    {contact.phone && ` · ${contact.phone}`}
                  </div>
                </div>

                {/* Stage badge */}
                <span className={`hidden sm:inline-flex px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border ${funnelColors[contact.funnelStage] || funnelColors.visitante}`}>
                  {STAGES_EXTENDED.find(s => s.key === contact.funnelStage)?.label || contact.funnelStage || 'Nuevo'}
                </span>

                {/* Orders & Total */}
                <div className="hidden md:flex flex-col items-end text-right">
                  <span className="text-sm font-black text-slate-900">{formatCRC(contact.totalSpent || 0)}</span>
                  <span className="text-[10px] text-slate-400">{contact.totalOrders || 0} pedido(s)</span>
                </div>

                {/* Status */}
                <div className="hidden lg:block">
                  {contact.unresolvedAttentionRequired ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 border border-red-200 text-red-600 rounded-full text-[10px] font-bold">
                      <AlertCircle className="w-3 h-3" /> Pendiente
                    </span>
                  ) : contact.lastIntent ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 border border-green-200 text-green-600 rounded-full text-[10px] font-bold">
                      <Brain className="w-3 h-3" /> {contact.lastIntent}
                    </span>
                  ) : null}
                </div>

                {/* Edit button */}
                <button
                  onClick={e => { e.stopPropagation(); startEditing(contact); }}
                  className="p-2 rounded-lg hover:bg-slate-100 transition-colors text-slate-400 hover:text-rose-500"
                  title="Editar contacto"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    // Doble confirmación para evitar borrar datos CRM por accidente
                    if (!confirm(`⚠️ ¿ELIMINAR PERMANENTEMENTE el contacto ${contact.displayName || contact.phone}?\n\nEsto borra:\n- Todos los mensajes\n- Nombre, dirección, historial\n- Datos de pago\n\nSi solo querés borrar la conversación, usá "Limpiar Historial" en la página de Soporte.`)) return;
                    if (!confirm(`🚨 ÚLTIMA CONFIRMACIÓN: ¿Seguro que querés eliminar "${contact.displayName || contact.phone}" del CRM? Esta acción NO se puede deshacer.`)) return;
                    try {
                      const msgsSnap = await getDocs(collection(db, 'crm_contacts', contact.id, 'messages'));
                      const batch = writeBatch(db);
                      msgsSnap.docs.forEach(d => batch.delete(d.ref));
                      batch.delete(doc(db, 'crm_contacts', contact.id));
                      await batch.commit();
                      if (expanded === contact.id) setExpanded(null);
                    } catch (err) {
                      console.error('Error deleting contact:', err);
                      alert('Error al eliminar: ' + err.message);
                    }
                  }}
                  className="p-2 rounded-lg hover:bg-red-50 transition-colors text-slate-400 hover:text-red-500"
                  title="Eliminar contacto permanentemente"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Expanded: Details */}
              {expanded === contact.id && (
                <div className="border-t border-slate-100">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-5">
                    {/* Contact Details */}
                    <div className="space-y-3">
                      <h3 className="text-xs font-black text-slate-600 uppercase tracking-widest flex items-center gap-2">
                        <IdCard className="w-4 h-4" /> Datos del Cliente
                      </h3>
                      <div className="bg-slate-50 rounded-xl p-4 space-y-2 text-sm">
                        <div className="flex justify-between"><span className="text-slate-400">Nombre:</span><span className="font-bold text-slate-800">{contact.displayName || '—'}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Cédula:</span><span className="font-bold text-slate-800">{contact.cedula || '—'}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Email:</span><span className="font-bold text-slate-800">{contact.email || '—'}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Teléfono:</span><span className="font-bold text-slate-800">{contact.phone || '—'}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Etapa:</span><span className="font-bold text-slate-800">{STAGES_EXTENDED.find(s => s.key === contact.funnelStage)?.label || contact.funnelStage || '—'}</span></div>
                      </div>

                      <h3 className="text-xs font-black text-slate-600 uppercase tracking-widest flex items-center gap-2 pt-2">
                        <MapPin className="w-4 h-4" /> Dirección
                      </h3>
                      <div className="bg-slate-50 rounded-xl p-4 space-y-2 text-sm">
                        <div className="flex justify-between"><span className="text-slate-400">Provincia:</span><span className="font-bold text-slate-800">{contact.lastAddress?.provincia || '—'}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Cantón:</span><span className="font-bold text-slate-800">{contact.lastAddress?.canton || '—'}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Distrito:</span><span className="font-bold text-slate-800">{contact.lastAddress?.distrito || '—'}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Código Postal:</span><span className="font-bold text-slate-800">{contact.lastAddress?.codigoPostal || '—'}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Señas:</span><span className="font-bold text-slate-800">{contact.lastAddress?.señas || '—'}</span></div>
                      </div>

                      <h3 className="text-xs font-black text-slate-600 uppercase tracking-widest flex items-center gap-2 pt-2">
                        <CreditCard className="w-4 h-4" /> Pago
                      </h3>
                      <div className="bg-slate-50 rounded-xl p-4 space-y-2 text-sm">
                        <div className="flex justify-between"><span className="text-slate-400">Método preferido:</span><span className="font-bold text-slate-800">{contact.preferredPaymentMethod || '—'}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Tel. pago:</span><span className="font-bold text-slate-800">{contact.paymentPhone || '—'}</span></div>
                      </div>
                    </div>

                    {/* Messages */}
                    <div>
                      <h3 className="text-xs font-black text-slate-600 uppercase tracking-widest flex items-center gap-2 mb-3">
                        <MessageCircle className="w-4 h-4" /> Mensajes Recientes
                      </h3>
                      <div className="bg-slate-50 rounded-xl p-4 max-h-80 overflow-y-auto">
                        {loadingMessages ? (
                          <p className="text-xs text-slate-400 animate-pulse">Cargando...</p>
                        ) : messages.length > 0 ? (
                          <div className="space-y-2">
                            {messages.map(msg => (
                              <div
                                key={msg.id}
                                className={`p-3 rounded-xl text-xs max-w-[90%] ${
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
                    </div>
                  </div>
                </div>
              )}

              {/* Edit modal */}
              {editing === contact.id && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setEditing(null)}>
                  <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between p-5 border-b border-slate-100">
                      <h3 className="font-black text-lg text-slate-900">Editar Contacto</h3>
                      <button onClick={() => setEditing(null)} className="p-1 rounded-lg hover:bg-slate-100"><X className="w-5 h-5 text-slate-400" /></button>
                    </div>

                    <div className="p-5 space-y-5">
                      {/* Datos personales */}
                      <div>
                        <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-1"><IdCard className="w-3.5 h-3.5" /> Datos Personales</h4>
                        <div className="grid grid-cols-2 gap-3">
                          <InputField label="Nombre" value={editForm.displayName} onChange={v => setEditForm(p => ({ ...p, displayName: v }))} placeholder="Nombre completo" />
                          <InputField label="Cédula" value={editForm.cedula} onChange={v => setEditForm(p => ({ ...p, cedula: v }))} placeholder="0-0000-0000" />
                          <InputField label="Email" value={editForm.email} onChange={v => setEditForm(p => ({ ...p, email: v }))} placeholder="email@ejemplo.com" />
                          <InputField label="Teléfono" value={editForm.phone} onChange={v => setEditForm(p => ({ ...p, phone: v }))} placeholder="8888-8888" />
                          <div className="col-span-2">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">Etapa</label>
                            <select
                              value={editForm.funnelStage}
                              onChange={e => setEditForm(p => ({ ...p, funnelStage: e.target.value }))}
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-rose-500"
                            >
                              {STAGES_EXTENDED.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                            </select>
                          </div>
                        </div>
                      </div>

                      {/* Dirección */}
                      <div>
                        <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> Dirección</h4>

                        {/* Código Postal shortcut */}
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
                          <label className="text-[10px] font-bold text-amber-600 uppercase block mb-1">📮 Código Postal (auto-llena)</label>
                          <input
                            value={editForm.codigoPostal}
                            onChange={e => {
                              const clean = e.target.value.replace(/\D/g, '').slice(0, 5);
                              setEditForm(p => ({ ...p, codigoPostal: clean }));
                              if (clean.length === 5) {
                                const result = buscarPorCodigoPostal(clean);
                                if (result) {
                                  setEditForm(p => ({
                                    ...p,
                                    provincia: result.provincia,
                                    canton: result.canton,
                                    distrito: result.distrito,
                                    codigoPostal: result.codigo,
                                  }));
                                }
                              }
                            }}
                            placeholder="Ej: 10301"
                            maxLength={5}
                            className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm font-mono font-bold outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          {/* Provincia */}
                          <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">Provincia</label>
                            <select
                              value={editForm.provincia}
                              onChange={e => setEditForm(p => ({ ...p, provincia: e.target.value, canton: '', distrito: '' }))}
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-rose-500"
                            >
                              <option value="">Seleccionar...</option>
                              {getProvincias().map(p => <option key={p} value={p}>{p}</option>)}
                            </select>
                          </div>

                          {/* Cantón */}
                          <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">Cantón</label>
                            <select
                              value={editForm.canton}
                              onChange={e => setEditForm(p => ({ ...p, canton: e.target.value, distrito: '' }))}
                              disabled={!editForm.provincia}
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-rose-500 disabled:bg-slate-50 disabled:text-slate-300"
                            >
                              <option value="">Seleccionar...</option>
                              {editForm.provincia && getCantones(editForm.provincia).map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </div>

                          {/* Distrito */}
                          <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">Distrito</label>
                            <select
                              value={editForm.distrito}
                              onChange={e => {
                                const val = e.target.value;
                                const distritos = getDistritos(editForm.provincia, editForm.canton);
                                const found = distritos.find(d => d.distrito === val);
                                setEditForm(p => ({
                                  ...p,
                                  distrito: val,
                                  codigoPostal: found?.codigo || p.codigoPostal,
                                }));
                              }}
                              disabled={!editForm.canton}
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-rose-500 disabled:bg-slate-50 disabled:text-slate-300"
                            >
                              <option value="">Seleccionar...</option>
                              {editForm.canton && getDistritos(editForm.provincia, editForm.canton).map(d => <option key={d.distrito} value={d.distrito}>{d.distrito}</option>)}
                            </select>
                          </div>

                          {/* Código Postal (readonly) */}
                          <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">Código Postal</label>
                            <input
                              value={editForm.codigoPostal}
                              readOnly
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-500 font-mono"
                            />
                          </div>

                          <div className="col-span-2">
                            <InputField label="Señas" value={editForm.señas} onChange={v => setEditForm(p => ({ ...p, señas: v }))} placeholder="Frente a la farmacia..." />
                          </div>
                        </div>
                      </div>

                      {/* Pago */}
                      <div>
                        <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-1"><CreditCard className="w-3.5 h-3.5" /> Pago</h4>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">Método preferido</label>
                            <select
                              value={editForm.preferredPaymentMethod}
                              onChange={e => setEditForm(p => ({ ...p, preferredPaymentMethod: e.target.value }))}
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-rose-500"
                            >
                              <option value="">Sin preferencia</option>
                              <option value="sinpe">SINPE</option>
                              <option value="transferencia">Transferencia</option>
                              <option value="paypal">PayPal</option>
                            </select>
                          </div>
                          <InputField label="Tel. Pago" value={editForm.paymentPhone} onChange={v => setEditForm(p => ({ ...p, paymentPhone: v }))} placeholder="7095-6070" />
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-3 p-5 border-t border-slate-100">
                      <button onClick={() => setEditing(null)} className="px-4 py-2 text-sm font-bold text-slate-500 hover:text-slate-700">Cancelar</button>
                      <button
                        onClick={saveContact}
                        disabled={saving}
                        className="flex items-center gap-2 px-5 py-2.5 bg-rose-600 text-white font-bold rounded-xl shadow-lg hover:bg-rose-700 active:scale-95 transition-all text-sm disabled:opacity-50"
                      >
                        <Save className="w-4 h-4" />
                        {saving ? 'Guardando...' : 'Guardar'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Users}
          title="CRM vacío"
          message="Los contactos se crearán automáticamente cuando los clientes se registren o compren."
        />
      );
      })()}
    </div>
  );
}
