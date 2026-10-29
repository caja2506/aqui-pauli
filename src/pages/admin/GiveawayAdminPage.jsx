import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Gift, Loader2 } from 'lucide-react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useRole } from '../../contexts/RoleContext';
import { useCollection } from '../../hooks/useCollection';
import { useGiveaway } from '../../hooks/useGiveaway';
import { GIVEAWAY } from '../../services/giveawayService';
import { buildGiveawayCsv, giveawayEntryDate } from '../../utils/giveawayExport';
import { formatCRC } from '../../utils/formatters';

function GiveawayAdminContent() {
  const { data, loading, error, retry } = useCollection('giveawayEntries', {
    orderByField: 'number', orderDirection: 'asc',
  });
  const giveaway = useGiveaway();
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const entries = data.filter((entry) => entry.campaignId === GIVEAWAY.campaignId);
  const statusLabels = {
    active: 'Inscripciones abiertas', upcoming: 'Todavía no comienza',
    closed: 'Cerrado por fecha', disabled: 'Apagado manualmente',
  };

  const toggleEnabled = async () => {
    if (saving || giveaway.loading || giveaway.error) return;
    setSaving(true);
    setActionError('');
    try {
      await setDoc(doc(db, 'config', 'giveaway'), {
        enabled: !giveaway.enabled, updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch {
      setActionError('No se pudo cambiar el estado del sorteo. Intentá de nuevo.');
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = () => {
    if (loading || error || entries.length === 0) return;
    const blob = new Blob([buildGiveawayCsv(entries)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sorteo-${GIVEAWAY.campaignId}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-slate-900 flex items-center gap-2"><Gift className="text-rose-600" /> Sorteo</h1>
          <p className="mt-2 text-sm text-slate-600">Inscripciones desde el 29 de octubre hasta el sábado 28 de noviembre de 2026 a las 8:00 p. m. de Costa Rica.</p>
          <p className="mt-1 text-sm text-slate-600">El sorteo será el domingo 29 de noviembre de 2026.</p>
          <Link to="/sorteo/bases" className="inline-block mt-2 text-sm font-bold text-rose-700 underline">Ver bases de participación</Link>
        </div>
        <button type="button" onClick={exportCsv} disabled={loading || !!error || entries.length === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-3 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed">
          <Download className="h-4 w-4" /> Exportar CSV
        </button>
      </div>

      <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5" aria-label="Estado del sorteo">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-bold text-slate-900" role="status">
              {giveaway.loading ? 'Cargando estado…' : giveaway.error ? 'No se pudo consultar el estado' : statusLabels[giveaway.status]}
            </p>
            <p className="mt-1 text-sm text-slate-600">Apagar oculta el banner y bloquea nuevas inscripciones. Conserva los participantes existentes.</p>
            <p className="mt-1 text-xs text-slate-600">El cierre por fecha se mantiene aunque el interruptor esté encendido.</p>
          </div>
          <button type="button" onClick={toggleEnabled} disabled={saving || giveaway.loading || giveaway.error}
            aria-pressed={giveaway.enabled}
            className="rounded-xl border border-rose-300 bg-white px-5 py-3 text-sm font-bold text-rose-800 disabled:opacity-50 disabled:cursor-not-allowed">
            {saving ? 'Guardando…' : giveaway.enabled ? 'Apagar sorteo' : 'Encender sorteo'}
          </button>
        </div>
        {actionError && <p role="alert" className="mt-3 text-sm text-red-700">{actionError}</p>}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden" aria-label="Participantes">
        <div className="p-5 border-b border-slate-100">
          <h2 className="font-black text-slate-900">Participantes{!loading && !error ? ` (${entries.length})` : ''}</h2>
          <p className="mt-1 text-sm text-slate-600">Lista privada. La columna de promociones indica quién autorizó ese contacto por separado.</p>
        </div>
        {loading ? (
          <p role="status" className="p-6 flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" /> Cargando participantes…</p>
        ) : error ? (
          <div className="p-6" role="alert">
            <p className="text-sm text-red-700">No se pudo cargar la lista de participantes.</p>
            <button type="button" onClick={retry} className="mt-3 text-sm font-bold text-rose-700 underline">Reintentar</button>
          </div>
        ) : entries.length === 0 ? (
          <p className="p-6 text-sm text-slate-600">Todavía no hay participantes registrados.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Participantes del sorteo de octubre y noviembre de 2026. Fechas en hora de Costa Rica.</caption>
              <thead className="bg-slate-50 text-slate-600"><tr>
                {['Número', 'Nombre completo', 'Teléfono', 'Correo', 'Colonia escogida', 'Precio al inscribirse', 'Fecha (Costa Rica)', 'Promociones'].map((label) => (
                  <th key={label} scope="col" className="px-4 py-3 font-bold whitespace-nowrap">{label}</th>
                ))}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-4 py-3 font-bold text-rose-700">#{entry.number}</td>
                    <td className="px-4 py-3 min-w-40">{entry.fullName}</td>
                    <td className="px-4 py-3 whitespace-nowrap">+506 {entry.phone}</td>
                    <td className="px-4 py-3 break-all">{entry.email}</td>
                    <td className="px-4 py-3 min-w-48">{entry.productName || entry.prizeLabel || 'Premio registrado'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{Number.isFinite(entry.productPrice) && entry.productPrice > 0 ? formatCRC(entry.productPrice) : '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{giveawayEntryDate(entry.createdAt)}</td>
                    <td className="px-4 py-3">{entry.promotionsConsent === true ? 'Sí' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default function GiveawayAdminPage() {
  const { isAdmin, roleLoading } = useRole();
  if (roleLoading) return <p role="status">Verificando acceso…</p>;
  if (!isAdmin) return <p role="alert">Acceso reservado a administradores.</p>;
  return <GiveawayAdminContent />;
}
