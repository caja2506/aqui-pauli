import { useState, useEffect, useMemo } from 'react';
import {
  MessageCircle, Activity, AlertTriangle, Settings, Bug, FlaskConical,
  RefreshCw, ChevronRight, Zap, Shield, Database, Eye, Filter,
  Clock, TrendingUp, TrendingDown, ArrowUpRight, Layers, GitBranch,
  CheckCircle2, XCircle, AlertCircle, Search, ChevronDown
} from 'lucide-react';
import { collection, query, orderBy, limit, getDocs, where, doc, setDoc, addDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from '../../firebase';

// ════════════════════════════════════════════
// STATE MACHINE DEFINITION (mirror of backend)
// ════════════════════════════════════════════
const STAGES = {
  greeting: { label: 'Saludo', color: 'bg-blue-500', description: 'Primer contacto' },
  discovery: { label: 'Exploración', color: 'bg-indigo-500', description: 'Buscando productos' },
  product_selection: { label: 'Selección', color: 'bg-purple-500', description: 'Producto específico' },
  variant_selection: { label: 'Variante', color: 'bg-violet-500', description: 'Talla/color' },
  address_capture: { label: 'Dirección', color: 'bg-amber-500', description: 'Datos de envío' },
  delivery_validation: { label: 'Validación', color: 'bg-orange-500', description: 'Confirmar datos' },
  payment_pending: { label: 'Pago', color: 'bg-yellow-500', description: 'Esperando pago' },
  payment_verification: { label: 'Verificación', color: 'bg-lime-500', description: 'Verificando comprobante' },
  order_confirmation: { label: 'Confirmado', color: 'bg-emerald-500', description: 'Pedido confirmado' },
  handoff_human: { label: 'Humano', color: 'bg-red-500', description: 'Escalado' },
  closed: { label: 'Cerrada', color: 'bg-slate-500', description: 'Finalizada' },
};

const TRANSITIONS = {
  greeting: ['discovery', 'product_selection', 'variant_selection', 'address_capture', 'delivery_validation', 'handoff_human'],
  discovery: ['product_selection', 'variant_selection', 'address_capture', 'payment_pending', 'handoff_human', 'greeting'],
  product_selection: ['variant_selection', 'address_capture', 'delivery_validation', 'discovery', 'handoff_human'],
  variant_selection: ['address_capture', 'delivery_validation', 'product_selection', 'handoff_human'],
  address_capture: ['delivery_validation', 'payment_pending', 'variant_selection', 'handoff_human'],
  delivery_validation: ['payment_pending', 'address_capture', 'handoff_human'],
  payment_pending: ['payment_verification', 'order_confirmation', 'handoff_human'],
  payment_verification: ['order_confirmation', 'payment_pending', 'handoff_human'],
  order_confirmation: ['discovery', 'closed', 'handoff_human'],
  handoff_human: ['greeting', 'discovery', 'closed'],
  closed: ['greeting'],
};

// ════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ════════════════════════════════════════════
export default function WhatsAppPage() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sessions, setSessions] = useState([]);
  const [logs, setLogs] = useState([]);
  const [changelog, setChangelog] = useState([]);
  const [bugs, setBugs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);

  const tabs = [
    { id: 'dashboard', label: 'Resumen', icon: Activity },
    { id: 'stateMachine', label: 'Máquina de Estados', icon: GitBranch },
    { id: 'logs', label: 'Trazabilidad', icon: Eye },
    { id: 'changelog', label: 'Changelog', icon: Clock },
    { id: 'bugs', label: 'Bugs', icon: Bug },
    { id: 'config', label: 'Configuración', icon: Settings },
  ];

  // ── Load data ──
  useEffect(() => { loadAllData(); }, []);

  async function loadAllData() {
    setLoading(true);
    try {
      await Promise.all([loadSessions(), loadLogs(), loadChangelog(), loadBugs()]);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error loading data:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadSessions() {
    const q = query(collection(db, 'bot_sessions'), orderBy('updatedAt', 'desc'), limit(100));
    const snap = await getDocs(q);
    setSessions(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }

  async function loadLogs() {
    const q = query(collection(db, 'bot_logs'), orderBy('createdAt', 'desc'), limit(200));
    const snap = await getDocs(q);
    setLogs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }

  async function loadChangelog() {
    const q = query(collection(db, 'whatsapp_change_log'), orderBy('createdAt', 'desc'), limit(50));
    try {
      const snap = await getDocs(q);
      setChangelog(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch { setChangelog([]); }
  }

  async function loadBugs() {
    const q = query(collection(db, 'whatsapp_bug_reports'), orderBy('createdAt', 'desc'), limit(50));
    try {
      const snap = await getDocs(q);
      setBugs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch { setBugs([]); }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl flex items-center justify-center">
              <MessageCircle className="w-5 h-5 text-white" />
            </div>
            WhatsApp Control Center
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Observabilidad, configuración y control operativo del bot
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-slate-500">
              Actualizado: {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={loadAllData}
            disabled={loading}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-sm font-bold flex items-center gap-2 transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refrescar
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto pb-2 border-b border-slate-800">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 rounded-t-xl text-sm font-bold flex items-center gap-2 whitespace-nowrap transition-all ${
              activeTab === tab.id
                ? 'bg-slate-800 text-white border-b-2 border-emerald-500'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="min-h-[60vh]">
        {activeTab === 'dashboard' && <DashboardTab sessions={sessions} logs={logs} bugs={bugs} />}
        {activeTab === 'stateMachine' && <StateMachineTab sessions={sessions} />}
        {activeTab === 'logs' && <LogsTab logs={logs} />}
        {activeTab === 'changelog' && <ChangelogTab changelog={changelog} onRefresh={loadChangelog} />}
        {activeTab === 'bugs' && <BugsTab bugs={bugs} onRefresh={loadBugs} />}
        {activeTab === 'config' && <ConfigTab />}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
// TAB: DASHBOARD (Resumen Operativo)
// ════════════════════════════════════════════
function DashboardTab({ sessions, logs, bugs }) {
  const metrics = useMemo(() => {
    const now = Date.now();
    const h24 = 24 * 60 * 60 * 1000;
    const recentSessions = sessions.filter(s => now - new Date(s.updatedAt).getTime() < h24);
    const activeSessions = recentSessions.filter(s => s.currentStage !== 'closed');
    const stuckSessions = activeSessions.filter(s => s.lowConfidenceStreak >= 2);
    const recentLogs = logs.filter(l => now - new Date(l.createdAt).getTime() < h24);
    const errors = recentLogs.filter(l => l.type === 'error' || (l.errors && l.errors.length > 0));
    const escalated = activeSessions.filter(s => s.escalationFlag || s.currentStage === 'handoff_human');
    const guardrailIssues = recentLogs.filter(l => l.guardrailIssues && l.guardrailIssues.length > 0);
    const avgResponseTime = recentLogs.length > 0
      ? Math.round(recentLogs.reduce((sum, l) => sum + (l.responseTimeMs || 0), 0) / recentLogs.length)
      : 0;

    // Stage distribution
    const stageDistribution = {};
    activeSessions.forEach(s => {
      stageDistribution[s.currentStage] = (stageDistribution[s.currentStage] || 0) + 1;
    });

    // Most common intent
    const intentCounts = {};
    recentLogs.forEach(l => {
      const intent = l.geminiResponse?.intent || 'unknown';
      intentCounts[intent] = (intentCounts[intent] || 0) + 1;
    });

    const openBugs = bugs.filter(b => b.status !== 'closed' && b.status !== 'resolved');
    const criticalBugs = openBugs.filter(b => b.severity === 'critical' || b.severity === 'high');

    return {
      totalConversations: recentSessions.length,
      active: activeSessions.length,
      stuck: stuckSessions.length,
      errors: errors.length,
      escalated: escalated.length,
      avgResponseTime,
      guardrailIssues: guardrailIssues.length,
      stageDistribution,
      intentCounts,
      openBugs: openBugs.length,
      criticalBugs: criticalBugs.length,
    };
  }, [sessions, logs, bugs]);

  const cards = [
    { label: 'Conversaciones (24h)', value: metrics.totalConversations, icon: MessageCircle, color: 'from-blue-500 to-blue-600' },
    { label: 'Activas', value: metrics.active, icon: Activity, color: 'from-emerald-500 to-emerald-600' },
    { label: 'Trabadas', value: metrics.stuck, icon: AlertTriangle, color: metrics.stuck > 0 ? 'from-amber-500 to-amber-600' : 'from-slate-600 to-slate-700' },
    { label: 'Errores (24h)', value: metrics.errors, icon: XCircle, color: metrics.errors > 0 ? 'from-red-500 to-red-600' : 'from-slate-600 to-slate-700' },
    { label: 'Escaladas', value: metrics.escalated, icon: ArrowUpRight, color: metrics.escalated > 0 ? 'from-orange-500 to-orange-600' : 'from-slate-600 to-slate-700' },
    { label: 'Resp. promedio', value: `${metrics.avgResponseTime}ms`, icon: Clock, color: 'from-purple-500 to-purple-600' },
    { label: 'Guardrail Issues', value: metrics.guardrailIssues, icon: Shield, color: metrics.guardrailIssues > 0 ? 'from-yellow-500 to-yellow-600' : 'from-slate-600 to-slate-700' },
    { label: 'Bugs abiertos', value: metrics.openBugs, icon: Bug, color: metrics.criticalBugs > 0 ? 'from-red-500 to-red-600' : 'from-slate-600 to-slate-700' },
  ];

  return (
    <div className="space-y-6">
      {/* Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((card, i) => (
          <div key={i} className="bg-slate-900 rounded-2xl p-4 border border-slate-800">
            <div className="flex items-center justify-between mb-3">
              <div className={`w-9 h-9 bg-gradient-to-br ${card.color} rounded-xl flex items-center justify-center`}>
                <card.icon className="w-4 h-4 text-white" />
              </div>
            </div>
            <div className="text-2xl font-black">{card.value}</div>
            <div className="text-xs text-slate-400 mt-1">{card.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Stage Distribution */}
        <div className="bg-slate-900 rounded-2xl p-5 border border-slate-800">
          <h3 className="text-sm font-bold text-slate-300 mb-4 flex items-center gap-2">
            <Layers className="w-4 h-4" /> Distribución por Etapa
          </h3>
          <div className="space-y-2">
            {Object.entries(STAGES).map(([key, stage]) => {
              const count = metrics.stageDistribution[key] || 0;
              const pct = metrics.active > 0 ? Math.round((count / metrics.active) * 100) : 0;
              return (
                <div key={key} className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${stage.color}`} />
                  <span className="text-xs text-slate-400 w-24 truncate">{stage.label}</span>
                  <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div className={`h-full ${stage.color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs font-mono text-slate-500 w-8 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Intents */}
        <div className="bg-slate-900 rounded-2xl p-5 border border-slate-800">
          <h3 className="text-sm font-bold text-slate-300 mb-4 flex items-center gap-2">
            <Zap className="w-4 h-4" /> Intenciones Detectadas (24h)
          </h3>
          <div className="space-y-2">
            {Object.entries(metrics.intentCounts)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 10)
              .map(([intent, count]) => {
                const total = Object.values(metrics.intentCounts).reduce((s, v) => s + v, 0);
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                return (
                  <div key={intent} className="flex items-center gap-3">
                    <span className="text-xs text-slate-400 w-28 truncate font-mono">{intent}</span>
                    <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs font-mono text-slate-500 w-10 text-right">{count} ({pct}%)</span>
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
// TAB: STATE MACHINE (Visualization)
// ════════════════════════════════════════════
function StateMachineTab({ sessions }) {
  const [selectedStage, setSelectedStage] = useState(null);

  // Count sessions per stage
  const stageCounts = useMemo(() => {
    const counts = {};
    sessions.forEach(s => {
      counts[s.currentStage] = (counts[s.currentStage] || 0) + 1;
    });
    return counts;
  }, [sessions]);

  // Visual positions for the state diagram
  const positions = {
    greeting: { x: 50, y: 30 },
    discovery: { x: 200, y: 30 },
    product_selection: { x: 350, y: 30 },
    variant_selection: { x: 500, y: 30 },
    address_capture: { x: 200, y: 130 },
    delivery_validation: { x: 350, y: 130 },
    payment_pending: { x: 500, y: 130 },
    payment_verification: { x: 350, y: 230 },
    order_confirmation: { x: 500, y: 230 },
    handoff_human: { x: 50, y: 230 },
    closed: { x: 200, y: 230 },
  };

  return (
    <div className="space-y-6">
      {/* State Machine Diagram */}
      <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800 overflow-x-auto">
        <h3 className="text-sm font-bold text-slate-300 mb-6 flex items-center gap-2">
          <GitBranch className="w-4 h-4" /> Máquina de Estados — Flujo Conversacional
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {Object.entries(STAGES).map(([key, stage]) => {
            const count = stageCounts[key] || 0;
            const isSelected = selectedStage === key;
            const transitions = TRANSITIONS[key] || [];
            return (
              <button
                key={key}
                onClick={() => setSelectedStage(isSelected ? null : key)}
                className={`relative p-4 rounded-2xl border transition-all text-left ${
                  isSelected
                    ? 'bg-slate-800 border-emerald-500 shadow-lg shadow-emerald-500/10'
                    : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-3 h-3 rounded-full ${stage.color}`} />
                  <span className="text-xs font-black">{stage.label}</span>
                </div>
                <div className="text-2xl font-black">{count}</div>
                <div className="text-[10px] text-slate-500 mt-1">{stage.description}</div>
                {count > 0 && (
                  <div className={`absolute top-2 right-2 w-2 h-2 rounded-full ${stage.color} animate-pulse`} />
                )}
                <div className="text-[10px] text-slate-600 mt-2">
                  → {transitions.length} salidas
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Stage Detail Panel */}
      {selectedStage && (
        <StageDetailPanel stageKey={selectedStage} sessions={sessions} />
      )}
    </div>
  );
}

function StageDetailPanel({ stageKey, sessions }) {
  const stage = STAGES[stageKey];
  const transitions = TRANSITIONS[stageKey] || [];
  const stageSessions = sessions.filter(s => s.currentStage === stageKey);

  return (
    <div className="bg-slate-900 rounded-2xl p-6 border border-emerald-500/30">
      <div className="flex items-center gap-3 mb-6">
        <div className={`w-4 h-4 rounded-full ${stage.color}`} />
        <h3 className="text-lg font-black">{stage.label}</h3>
        <span className="text-sm text-slate-400">({stageKey})</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Info */}
        <div className="space-y-3">
          <div>
            <div className="text-xs text-slate-500 font-bold mb-1">Descripción</div>
            <div className="text-sm text-slate-300">{stage.description}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 font-bold mb-1">Sesiones activas</div>
            <div className="text-2xl font-black">{stageSessions.length}</div>
          </div>
        </div>

        {/* Transitions */}
        <div>
          <div className="text-xs text-slate-500 font-bold mb-2">Transiciones válidas</div>
          <div className="space-y-1">
            {transitions.map(t => (
              <div key={t} className="flex items-center gap-2 text-xs">
                <ChevronRight className="w-3 h-3 text-emerald-500" />
                <span className="text-slate-300">{STAGES[t]?.label || t}</span>
                <span className="text-slate-600 font-mono">({t})</span>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Sessions in this stage */}
        <div>
          <div className="text-xs text-slate-500 font-bold mb-2">Sesiones recientes</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {stageSessions.slice(0, 8).map(s => (
              <div key={s.id} className="text-xs flex items-center justify-between bg-slate-800 rounded-lg px-3 py-2">
                <span className="text-slate-300 font-mono truncate w-32">{s.phoneNumber}</span>
                <span className="text-slate-500">T{s.turnCount}</span>
              </div>
            ))}
            {stageSessions.length === 0 && (
              <div className="text-xs text-slate-600">No hay sesiones en esta etapa</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
// TAB: LOGS (Trazabilidad)
// ════════════════════════════════════════════
function LogsTab({ logs }) {
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all'); // all, errors, guardrails, tools
  const [expanded, setExpanded] = useState(null);

  const filtered = useMemo(() => {
    let result = logs;
    if (filterType === 'errors') result = result.filter(l => l.type === 'error' || (l.errors?.length > 0));
    if (filterType === 'guardrails') result = result.filter(l => l.guardrailIssues?.length > 0);
    if (filterType === 'tools') result = result.filter(l => l.toolsCalled?.length > 0);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(l =>
        (l.sessionId || '').toLowerCase().includes(q) ||
        (l.userInput || '').toLowerCase().includes(q) ||
        (l.finalReply || '').toLowerCase().includes(q) ||
        (l.geminiResponse?.intent || '').toLowerCase().includes(q)
      );
    }
    return result.slice(0, 100);
  }, [logs, filterType, search]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            placeholder="Buscar por sesión, mensaje, intent..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div className="flex gap-2">
          {[
            { id: 'all', label: 'Todos' },
            { id: 'errors', label: '❌ Errores' },
            { id: 'guardrails', label: '🛡️ Guardrails' },
            { id: 'tools', label: '🔧 Tools' },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setFilterType(f.id)}
              className={`px-3 py-2 rounded-xl text-xs font-bold transition-all ${
                filterType === f.id
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Log Entries */}
      <div className="space-y-2">
        {filtered.map((log, i) => (
          <div
            key={log.id || i}
            className={`bg-slate-900 rounded-xl border transition-all ${
              log.type === 'error' || log.errors?.length > 0
                ? 'border-red-500/30'
                : log.guardrailIssues?.length > 0
                ? 'border-yellow-500/30'
                : 'border-slate-800'
            }`}
          >
            <button
              onClick={() => setExpanded(expanded === i ? null : i)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left"
            >
              {/* Status icon */}
              {log.type === 'error' || log.errors?.length > 0 ? (
                <XCircle className="w-4 h-4 text-red-500 shrink-0" />
              ) : log.guardrailIssues?.length > 0 ? (
                <AlertCircle className="w-4 h-4 text-yellow-500 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              )}

              {/* Session & Intent */}
              <span className="text-xs font-mono text-slate-500 w-20 truncate shrink-0">
                {(log.sessionId || '').slice(-8)}
              </span>
              <span className="text-xs font-bold text-indigo-400 w-24 shrink-0">
                {log.geminiResponse?.intent || log.type || '-'}
              </span>

              {/* Stage */}
              <span className="text-xs text-slate-500 w-16 shrink-0">
                {log.sessionStateBefore?.currentStage || '-'}
              </span>

              {/* User message */}
              <span className="text-sm text-slate-300 flex-1 truncate">
                {log.userInput || log.error || '-'}
              </span>

              {/* Time */}
              <span className="text-[10px] text-slate-600 shrink-0">
                {log.responseTimeMs ? `${log.responseTimeMs}ms` : ''}
              </span>
              <span className="text-[10px] text-slate-600 shrink-0 w-16 text-right">
                {log.createdAt ? new Date(log.createdAt).toLocaleTimeString() : ''}
              </span>

              <ChevronDown className={`w-4 h-4 text-slate-600 shrink-0 transition-transform ${expanded === i ? 'rotate-180' : ''}`} />
            </button>

            {/* Expanded Detail */}
            {expanded === i && (
              <div className="px-4 pb-4 border-t border-slate-800 pt-3 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div>
                    <div className="text-slate-500 font-bold mb-1">👤 Mensaje del usuario</div>
                    <div className="text-slate-300 bg-slate-800 rounded-lg p-3">{log.userInput || '-'}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 font-bold mb-1">🤖 Respuesta del bot</div>
                    <div className="text-slate-300 bg-slate-800 rounded-lg p-3">{log.finalReply || '-'}</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div>
                    <div className="text-slate-500 font-bold">Etapa antes</div>
                    <div className="text-slate-300">{log.sessionStateBefore?.currentStage || '-'}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 font-bold">Etapa después</div>
                    <div className="text-slate-300">{log.sessionStateAfter?.currentStage || '-'}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 font-bold">Confianza</div>
                    <div className="text-slate-300">{log.geminiResponse?.confidence ?? '-'}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 font-bold">Alucinación</div>
                    <div className="text-slate-300">{log.geminiResponse?.hallucinationRisk || '-'}</div>
                  </div>
                </div>

                {log.toolsCalled?.length > 0 && (
                  <div>
                    <div className="text-xs text-slate-500 font-bold mb-1">🔧 Tools ejecutadas</div>
                    {log.toolsCalled.map((t, j) => (
                      <div key={j} className="text-xs bg-slate-800 rounded-lg p-2 mb-1 flex items-center gap-3">
                        <span className={`${t.success ? 'text-emerald-400' : 'text-red-400'} font-mono`}>{t.name}</span>
                        <span className="text-slate-500 truncate">{t.resultSummary}</span>
                      </div>
                    ))}
                  </div>
                )}

                {log.guardrailIssues?.length > 0 && (
                  <div>
                    <div className="text-xs text-yellow-500 font-bold mb-1">⚠️ Guardrails</div>
                    <ul className="text-xs text-yellow-400/80 list-disc pl-4">
                      {log.guardrailIssues.map((issue, j) => <li key={j}>{issue}</li>)}
                    </ul>
                  </div>
                )}

                {log.errors?.length > 0 && (
                  <div>
                    <div className="text-xs text-red-500 font-bold mb-1">❌ Errores</div>
                    <ul className="text-xs text-red-400/80 list-disc pl-4">
                      {log.errors.map((err, j) => <li key={j}>{typeof err === 'string' ? err : err.message || JSON.stringify(err)}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <Eye className="w-8 h-8 mx-auto mb-3 opacity-50" />
            <p className="text-sm font-bold">Sin logs que mostrar</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
// TAB: CHANGELOG
// ════════════════════════════════════════════
function ChangelogTab({ changelog, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    module: '', stage: '', type: 'feature', description: '', reason: '',
    hypothesis: '', risk: 'low', expectedOutcome: '', observedOutcome: '',
    conclusion: '', classification: 'pending',
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await addDoc(collection(db, 'whatsapp_change_log'), {
        ...form,
        author: 'admin',
        createdAt: new Date().toISOString(),
        rollbackApplied: false,
      });
      setShowForm(false);
      setForm({ module: '', stage: '', type: 'feature', description: '', reason: '', hypothesis: '', risk: 'low', expectedOutcome: '', observedOutcome: '', conclusion: '', classification: 'pending' });
      onRefresh();
    } catch (err) {
      console.error('Error saving changelog:', err);
    } finally { setSaving(false); }
  }

  const classColors = {
    mejora: 'text-emerald-400 bg-emerald-500/10',
    empeora: 'text-red-400 bg-red-500/10',
    neutro: 'text-slate-400 bg-slate-500/10',
    pending: 'text-yellow-400 bg-yellow-500/10',
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-300">Registro de Cambios</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-xs font-bold transition-all"
        >
          + Nuevo Cambio
        </button>
      </div>

      {showForm && (
        <div className="bg-slate-900 rounded-2xl p-5 border border-emerald-500/30 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500" placeholder="Módulo afectado" value={form.module} onChange={e => setForm({ ...form, module: e.target.value })} />
            <input className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500" placeholder="Etapa afectada" value={form.stage} onChange={e => setForm({ ...form, stage: e.target.value })} />
            <select className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
              <option value="feature">Feature</option>
              <option value="fix">Fix</option>
              <option value="refactor">Refactor</option>
              <option value="config">Config</option>
              <option value="prompt">Prompt</option>
            </select>
          </div>
          <textarea className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 h-20" placeholder="Descripción del cambio..." value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500" placeholder="Motivo" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
            <input className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500" placeholder="Hipótesis" value={form.hypothesis} onChange={e => setForm({ ...form, hypothesis: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <select className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white" value={form.risk} onChange={e => setForm({ ...form, risk: e.target.value })}>
              <option value="low">Riesgo bajo</option>
              <option value="medium">Riesgo medio</option>
              <option value="high">Riesgo alto</option>
            </select>
            <input className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500" placeholder="Resultado esperado" value={form.expectedOutcome} onChange={e => setForm({ ...form, expectedOutcome: e.target.value })} />
            <select className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white" value={form.classification} onChange={e => setForm({ ...form, classification: e.target.value })}>
              <option value="pending">⏳ Pendiente</option>
              <option value="mejora">✅ Mejora</option>
              <option value="empeora">❌ Empeora</option>
              <option value="neutro">➖ Neutro</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-slate-800 rounded-xl text-xs font-bold text-slate-400">Cancelar</button>
            <button onClick={handleSave} disabled={saving || !form.description} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-xs font-bold disabled:opacity-50">
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>
      )}

      {/* Changelog List */}
      <div className="space-y-2">
        {changelog.map(entry => (
          <div key={entry.id} className="bg-slate-900 rounded-xl border border-slate-800 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${classColors[entry.classification] || classColors.pending}`}>
                    {entry.classification?.toUpperCase() || 'PENDING'}
                  </span>
                  <span className="text-[10px] font-mono text-slate-600 bg-slate-800 px-2 py-0.5 rounded-full">{entry.type}</span>
                  {entry.module && <span className="text-[10px] text-slate-500">{entry.module}</span>}
                </div>
                <p className="text-sm text-slate-300">{entry.description}</p>
                {entry.reason && <p className="text-xs text-slate-500 mt-1">Motivo: {entry.reason}</p>}
              </div>
              <span className="text-[10px] text-slate-600 shrink-0">
                {entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : ''}
              </span>
            </div>
          </div>
        ))}
        {changelog.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <Clock className="w-8 h-8 mx-auto mb-3 opacity-50" />
            <p className="text-sm font-bold">Sin registros de cambios</p>
            <p className="text-xs text-slate-600 mt-1">Usá el botón superior para documentar cada cambio</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
// TAB: BUGS
// ════════════════════════════════════════════
function BugsTab({ bugs, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    title: '', description: '', severity: 'medium', stage: '',
    reproducible: true, status: 'open', responsible: '',
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await addDoc(collection(db, 'whatsapp_bug_reports'), {
        ...form,
        createdAt: new Date().toISOString(),
        closedAt: null,
        fixApplied: '',
        validated: false,
        regression: false,
      });
      setShowForm(false);
      setForm({ title: '', description: '', severity: 'medium', stage: '', reproducible: true, status: 'open', responsible: '' });
      onRefresh();
    } catch (err) {
      console.error('Error saving bug:', err);
    } finally { setSaving(false); }
  }

  const severityColors = {
    critical: 'text-red-400 bg-red-500/10 border-red-500/30',
    high: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
    medium: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
    low: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  };

  const statusColors = {
    open: 'text-red-400',
    'in-progress': 'text-yellow-400',
    resolved: 'text-emerald-400',
    closed: 'text-slate-400',
  };

  const openBugs = bugs.filter(b => b.status === 'open' || b.status === 'in-progress');
  const closedBugs = bugs.filter(b => b.status === 'closed' || b.status === 'resolved');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h3 className="text-sm font-bold text-slate-300">Bug Tracker — WhatsApp</h3>
          <span className="text-xs font-bold text-red-400 bg-red-500/10 px-2 py-1 rounded-full">
            {openBugs.length} abiertos
          </span>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-xl text-xs font-bold transition-all"
        >
          + Reportar Bug
        </button>
      </div>

      {showForm && (
        <div className="bg-slate-900 rounded-2xl p-5 border border-red-500/30 space-y-3">
          <input className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500" placeholder="Título del bug" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
          <textarea className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 h-20" placeholder="Descripción detallada..." value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <select className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white" value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })}>
              <option value="critical">🔴 Crítico</option>
              <option value="high">🟠 Alto</option>
              <option value="medium">🟡 Medio</option>
              <option value="low">🔵 Bajo</option>
            </select>
            <input className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500" placeholder="Etapa afectada" value={form.stage} onChange={e => setForm({ ...form, stage: e.target.value })} />
            <input className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500" placeholder="Responsable" value={form.responsible} onChange={e => setForm({ ...form, responsible: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-slate-800 rounded-xl text-xs font-bold text-slate-400">Cancelar</button>
            <button onClick={handleSave} disabled={saving || !form.title} className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-xl text-xs font-bold disabled:opacity-50">
              {saving ? 'Guardando...' : 'Reportar'}
            </button>
          </div>
        </div>
      )}

      {/* Bug List */}
      <div className="space-y-2">
        {bugs.map(bug => (
          <div key={bug.id} className={`bg-slate-900 rounded-xl border p-4 ${severityColors[bug.severity] || 'border-slate-800'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs font-bold ${statusColors[bug.status] || 'text-slate-400'}`}>
                    {bug.status?.toUpperCase()}
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${severityColors[bug.severity] || ''}`}>
                    {bug.severity?.toUpperCase()}
                  </span>
                  {bug.stage && <span className="text-[10px] text-slate-500">📍 {bug.stage}</span>}
                </div>
                <p className="text-sm font-bold text-white">{bug.title}</p>
                <p className="text-xs text-slate-400 mt-1">{bug.description}</p>
                {bug.fixApplied && <p className="text-xs text-emerald-400 mt-1">Fix: {bug.fixApplied}</p>}
              </div>
              <span className="text-[10px] text-slate-600 shrink-0">
                {bug.createdAt ? new Date(bug.createdAt).toLocaleDateString() : ''}
              </span>
            </div>
          </div>
        ))}
        {bugs.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <Bug className="w-8 h-8 mx-auto mb-3 opacity-50" />
            <p className="text-sm font-bold">Sin bugs reportados</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
// TAB: CONFIGURATION
// ════════════════════════════════════════════
function ConfigTab() {
  const [globalMode, setGlobalMode] = useState('hybrid');
  const [saving, setSaving] = useState(false);

  const modes = [
    { value: 'rule_based', label: 'Solo Reglas', description: 'Sin IA, solo lógica determinista', icon: Shield, color: 'border-blue-500' },
    { value: 'hybrid', label: 'Híbrido', description: 'Reglas duras + IA para interpretación', icon: Zap, color: 'border-emerald-500' },
    { value: 'ai_first', label: 'IA Primero', description: 'IA decide, reglas validan', icon: FlaskConical, color: 'border-purple-500' },
    { value: 'safe_mode', label: 'Modo Seguro', description: 'Mínimo de IA, máximo control', icon: Shield, color: 'border-amber-500' },
    { value: 'sandbox', label: 'Sandbox', description: 'Solo para pruebas internas', icon: Database, color: 'border-slate-500' },
  ];

  const submodules = [
    'intent_detection', 'entity_extraction', 'response_generation',
    'tool_selection', 'state_transition', 'fallback_generation',
    'payment_interpretation', 'catalog_suggestion', 'context_summarization',
    'escalation_decision',
  ];

  async function handleSaveGlobalMode(mode) {
    setGlobalMode(mode);
    try {
      await setDoc(doc(db, 'whatsapp_config', 'global'), {
        mode,
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      }, { merge: true });
    } catch (err) {
      console.error('Error saving config:', err);
    }
  }

  return (
    <div className="space-y-6">
      {/* Global Mode */}
      <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800">
        <h3 className="text-sm font-bold text-slate-300 mb-4 flex items-center gap-2">
          <Settings className="w-4 h-4" /> Modo de Operación Global
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {modes.map(mode => (
            <button
              key={mode.value}
              onClick={() => handleSaveGlobalMode(mode.value)}
              className={`p-4 rounded-xl border-2 text-left transition-all ${
                globalMode === mode.value
                  ? `${mode.color} bg-slate-800`
                  : 'border-slate-700 hover:border-slate-600'
              }`}
            >
              <mode.icon className={`w-5 h-5 mb-2 ${globalMode === mode.value ? 'text-white' : 'text-slate-500'}`} />
              <div className="text-xs font-black">{mode.label}</div>
              <div className="text-[10px] text-slate-500 mt-1">{mode.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Submodule Modes */}
      <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800">
        <h3 className="text-sm font-bold text-slate-300 mb-4 flex items-center gap-2">
          <Layers className="w-4 h-4" /> Modo por Submódulo
        </h3>
        <div className="space-y-2">
          {submodules.map(mod => (
            <div key={mod} className="flex items-center justify-between bg-slate-800 rounded-xl px-4 py-3">
              <span className="text-xs font-bold text-slate-300">{mod.replace(/_/g, ' ')}</span>
              <select className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-white">
                <option value="hybrid">Híbrido</option>
                <option value="manual">Manual</option>
                <option value="rules">Reglas</option>
                <option value="ai">IA</option>
                <option value="disabled">Deshabilitado</option>
              </select>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
