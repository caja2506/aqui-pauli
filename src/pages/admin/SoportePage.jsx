import { useState, useEffect, useRef } from 'react';
import { MessageCircle, Send, Bot, User, Search, Phone, ChevronLeft } from 'lucide-react';
import { collection, query, orderBy, onSnapshot, doc, updateDoc } from 'firebase/firestore';
import { db, functions } from '../../firebase';
import { useCollection } from '../../hooks/useCollection';
import { httpsCallable } from 'firebase/functions';

const CHANNEL_COLORS = {
  whatsapp: 'bg-green-500',
  telegram: 'bg-blue-500',
};

const CHANNEL_LABELS = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
};

export default function SoportePage() {
  const { data: contacts, loading } = useCollection('crm_contacts');
  const [selectedContact, setSelectedContact] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [channelFilter, setChannelFilter] = useState('all');
  const [showMobileChat, setShowMobileChat] = useState(false);
  const messagesEndRef = useRef(null);

  // Filtrar contactos con mensajes
  const activeContacts = contacts
    .filter(c => c.lastMessageAt || c.lastInteractionAt || c.totalMessages > 0)
    .filter(c => {
      if (channelFilter !== 'all' && c.lastChannel !== channelFilter) return false;
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        return (c.displayName || '').toLowerCase().includes(term)
          || (c.phone || '').includes(term)
          || (c.email || '').toLowerCase().includes(term);
      }
      return true;
    })
    .sort((a, b) => {
      const aVal = a.lastMessageAt || a.lastInteractionAt || '';
      const bVal = b.lastMessageAt || b.lastInteractionAt || '';
      const aTime = typeof aVal === 'string' ? new Date(aVal) : (aVal?.toDate?.() || new Date(0));
      const bTime = typeof bVal === 'string' ? new Date(bVal) : (bVal?.toDate?.() || new Date(0));
      return bTime - aTime;
    });

  // Escuchar mensajes en tiempo real del contacto seleccionado
  useEffect(() => {
    if (!selectedContact) {
      setMessages([]);
      return;
    }

    setLoadingMsgs(true);
    const msgsRef = collection(db, 'crm_contacts', selectedContact.id, 'messages');

    const unsub = onSnapshot(msgsRef, (snap) => {
      const msgs = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      setMessages(msgs);
      setLoadingMsgs(false);
    }, (err) => {
      console.error('Error loading messages:', err);
      setLoadingMsgs(false);
    });

    return () => unsub();
  }, [selectedContact]);

  // Scroll al último mensaje
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Enviar mensaje manual
  const handleSend = async () => {
    if (!newMessage.trim() || !selectedContact || sending) return;

    const msg = newMessage.trim();
    setNewMessage('');
    setSending(true);

    try {
      const channel = selectedContact.lastChannel || 'whatsapp';
      const to = channel === 'whatsapp'
        ? selectedContact.phone
        : selectedContact.telegramChatId;

      if (!to) {
        alert('No se encontró número/chat del contacto');
        setSending(false);
        return;
      }

      if (channel === 'whatsapp') {
        const sendWA = httpsCallable(functions, 'sendWhatsAppMessage');
        await sendWA({
          to,
          message: msg,
          relatedContactUid: selectedContact.id,
        });
      }

      // Marcar como resuelto
      if (selectedContact.unresolvedAttentionRequired) {
        await updateDoc(doc(db, 'crm_contacts', selectedContact.id), {
          unresolvedAttentionRequired: false,
        });
      }
    } catch (err) {
      console.error('Error sending:', err);
      alert('Error al enviar: ' + err.message);
      setNewMessage(msg);
    } finally {
      setSending(false);
    }
  };

  const handleSelectContact = (contact) => {
    setSelectedContact(contact);
    setShowMobileChat(true);
  };

  const formatMsgTime = (msg) => {
    const ts = msg.createdAt?.toDate?.() || new Date(msg.createdAt || 0);
    return ts.toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit' });
  };

  const formatContactTime = (contact) => {
    const ts = contact.lastMessageAt?.toDate?.() || new Date(contact.lastMessageAt || 0);
    const now = new Date();
    const diff = now - ts;
    if (diff < 60000) return 'Ahora';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return ts.toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit' });
    return ts.toLocaleDateString('es-CR', { day: '2-digit', month: '2-digit' });
  };

  const unresolvedCount = contacts.filter(c => c.unresolvedAttentionRequired).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin w-8 h-8 border-2 border-rose-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-4rem)] md:h-[calc(100vh-6rem)] flex flex-col">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2.5 bg-rose-100 rounded-xl">
          <MessageCircle className="w-6 h-6 text-rose-600" />
        </div>
        <div>
          <h1 className="text-xl font-black text-slate-900">Soporte</h1>
          <p className="text-xs text-slate-500">
            {activeContacts.length} conversaciones{unresolvedCount > 0 ? ` · ${unresolvedCount} sin responder` : ''}
          </p>
        </div>
      </div>

      <div className="flex-1 flex bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mt-4">
        {/* === LISTA DE CONTACTOS (izquierda) === */}
        <div className={`w-full md:w-96 border-r border-slate-200 flex flex-col ${showMobileChat ? 'hidden md:flex' : 'flex'}`}>
          {/* Search + Filter */}
          <div className="p-3 border-b border-slate-100 space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Buscar contacto..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent"
              />
            </div>
            <div className="flex gap-1">
              {['all', 'whatsapp', 'telegram'].map(ch => (
                <button
                  key={ch}
                  onClick={() => setChannelFilter(ch)}
                  className={`px-3 py-1 text-xs font-bold rounded-full transition-all ${
                    channelFilter === ch
                      ? 'bg-rose-600 text-white'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {ch === 'all' ? 'Todos' : CHANNEL_LABELS[ch]}
                </button>
              ))}
            </div>
          </div>

          {/* Contact List */}
          <div className="flex-1 overflow-y-auto">
            {activeContacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-400 p-6">
                <MessageCircle className="w-12 h-12 mb-3 opacity-30" />
                <p className="text-sm font-bold">No hay conversaciones</p>
              </div>
            ) : (
              activeContacts.map(contact => (
                <button
                  key={contact.id}
                  onClick={() => handleSelectContact(contact)}
                  className={`w-full flex items-start gap-3 p-3 border-b border-slate-50 hover:bg-slate-50 transition-all text-left ${
                    selectedContact?.id === contact.id ? 'bg-rose-50 border-l-4 border-l-rose-500' : ''
                  }`}
                >
                  {/* Avatar */}
                  <div className="relative shrink-0">
                    <div className="w-11 h-11 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-bold text-sm">
                      {(contact.displayName || contact.phone || '?')[0].toUpperCase()}
                    </div>
                    {contact.lastChannel && (
                      <div className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full ${CHANNEL_COLORS[contact.lastChannel]} border-2 border-white`} />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-bold text-slate-900 truncate">
                        {contact.displayName || contact.phone || 'Desconocido'}
                      </p>
                      <span className="text-[10px] text-slate-400 shrink-0 ml-2">
                        {formatContactTime(contact)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 truncate mt-0.5">
                      {contact.lastMessageContent || 'Sin mensajes'}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      {contact.phone && (
                        <span className="text-[10px] text-slate-400 flex items-center gap-0.5">
                          <Phone className="w-3 h-3" />{contact.phone}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Badge sin responder */}
                  {contact.unresolvedAttentionRequired && (
                    <div className="w-3 h-3 bg-rose-500 rounded-full shrink-0 mt-1 animate-pulse" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* === CHAT (derecha) === */}
        <div className={`flex-1 flex flex-col ${!showMobileChat ? 'hidden md:flex' : 'flex'}`}>
          {!selectedContact ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
              <MessageCircle className="w-20 h-20 mb-4 opacity-20" />
              <p className="text-lg font-bold">Selecciona una conversación</p>
              <p className="text-sm mt-1">Elige un contacto de la lista para ver el chat</p>
            </div>
          ) : (
            <>
              {/* Chat Header */}
              <div className="flex items-center gap-3 p-4 border-b border-slate-200 bg-white">
                <button
                  onClick={() => setShowMobileChat(false)}
                  className="md:hidden p-1 hover:bg-slate-100 rounded-lg"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div className="relative">
                  <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-bold">
                    {(selectedContact.displayName || selectedContact.phone || '?')[0].toUpperCase()}
                  </div>
                  {selectedContact.lastChannel && (
                    <div className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full ${CHANNEL_COLORS[selectedContact.lastChannel]} border-2 border-white`} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-900 truncate">
                    {selectedContact.displayName || selectedContact.phone || 'Desconocido'}
                  </p>
                  <p className="text-xs text-slate-400">
                    {selectedContact.phone && `${selectedContact.phone} · `}
                    {CHANNEL_LABELS[selectedContact.lastChannel] || 'Chat'}
                    {selectedContact.totalOrders > 0 && ` · ${selectedContact.totalOrders} pedido(s)`}
                  </p>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50"
                style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23e2e8f0\' fill-opacity=\'0.3\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")' }}
              >
                {loadingMsgs ? (
                  <div className="flex justify-center py-8">
                    <div className="animate-spin w-6 h-6 border-2 border-rose-500 border-t-transparent rounded-full" />
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-slate-400">
                    <p className="text-sm">No hay mensajes aún</p>
                  </div>
                ) : (
                  messages.map(msg => {
                    const isInbound = msg.direction === 'inbound';
                    const isAutoReply = msg.autoReply;

                    return (
                      <div key={msg.id} className={`flex ${isInbound ? 'justify-start' : 'justify-end'}`}>
                        <div className={`relative max-w-[80%] md:max-w-[65%] px-4 py-2.5 rounded-2xl shadow-sm ${
                          isInbound
                            ? 'bg-white text-slate-900 rounded-bl-sm'
                            : isAutoReply
                              ? 'bg-emerald-500 text-white rounded-br-sm'
                              : 'bg-rose-600 text-white rounded-br-sm'
                        }`}>
                          {/* Sender indicator */}
                          <div className={`flex items-center gap-1 mb-1 ${isInbound ? 'text-slate-400' : 'text-white/70'}`}>
                            {isInbound ? (
                              <User className="w-3 h-3" />
                            ) : isAutoReply ? (
                              <Bot className="w-3 h-3" />
                            ) : (
                              <User className="w-3 h-3" />
                            )}
                            <span className="text-[10px] font-bold">
                              {isInbound ? (msg.contactName || 'Cliente') : (isAutoReply ? 'Bot 🤖' : 'Admin 👤')}
                            </span>
                          </div>

                          {/* Message content */}
                          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                            {msg.content}
                          </p>

                          {/* Time + channel */}
                          <div className={`flex items-center justify-end gap-1 mt-1 ${isInbound ? 'text-slate-300' : 'text-white/50'}`}>
                            <span className="text-[10px]">{formatMsgTime(msg)}</span>
                            {msg.channel && (
                              <span className="text-[10px]">· {CHANNEL_LABELS[msg.channel] || msg.channel}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="p-3 border-t border-slate-200 bg-white">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                    placeholder="Escribe un mensaje..."
                    disabled={sending}
                    className="flex-1 px-4 py-3 text-sm bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent disabled:opacity-50"
                  />
                  <button
                    onClick={handleSend}
                    disabled={!newMessage.trim() || sending}
                    className="p-3 bg-rose-600 text-white rounded-2xl hover:bg-rose-700 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-md"
                  >
                    <Send className={`w-5 h-5 ${sending ? 'animate-pulse' : ''}`} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
