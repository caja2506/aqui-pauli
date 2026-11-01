import { useEffect, useState } from 'react';
import { collection, doc, onSnapshot, orderBy, query, runTransaction, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Link } from 'react-router-dom';
import { db, functions } from '../../firebase';
import { cardState } from '../../../functions/lib/promotions.mjs';

const states = ['Por imprimir', 'Impresos', 'Usados', 'Vencidos'];
const date = value => value ? new Date(value).toLocaleDateString('es-CR', {timeZone:'America/Costa_Rica'}) : '—';
const button = 'rounded-xl bg-rose-700 px-4 py-2 font-bold text-white disabled:opacity-50';
export default function DiscountCardsPage() {
  const [lots, setLots] = useState([]), [selected, setSelected] = useState('');
  const [filter, setFilter] = useState(states[0]), [loaded, setLoaded] = useState(null);
  const [batchId, setBatchId] = useState(''), [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const lot = selected || lots[0]?.id || '';
  useEffect(() => onSnapshot(query(collection(db,'discountBatches'),orderBy('createdAt','desc')),
    s => setLots(s.docs.map(d => ({id:d.id,...d.data()}))), () => setMessage('No pudimos cargar los lotes.')), []);
  useEffect(() => {
    if (!lot) return;
    return onSnapshot(query(collection(db,'discountCodes'),where('batchId','==',lot)),
      s => setLoaded({ lot, rows:s.docs.map(d=>d.data()).sort((a,b)=>a.code.localeCompare(b.code)) }),
      () => { setLoaded(null); setMessage('No pudimos cargar los códigos.'); });
  }, [lot]);
  const rows = loaded?.lot === lot ? loaded.rows : [];
  const pending = rows.filter(r=>cardState(r) === 'Por imprimir');
  const visible = rows.filter(r=>cardState(r) === filter);
  async function perform(action) {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await action(); } catch (e) { setMessage(e.message || 'No pudimos completar la acción.'); }
    finally { setBusy(false); }
  }
  const generate = () => perform(async () => {
    const id = batchId.trim();
    await httpsCallable(functions,'generateDiscountBatch')({ lote:id, n:Number(count) });
    setSelected(id); setFilter(states[0]); setMessage('Lote generado. Ya podés descargar sus tarjetas.');
  });
  const download = () => perform(async () => {
    const { cardPdf } = await import('../../utils/cardPdf.mjs');
    const url = URL.createObjectURL(new Blob([await cardPdf(pending)],{type:'application/pdf'}));
    const a = document.createElement('a'); a.href=url; a.download='tarjetitas_'+lot+'.pdf'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    setMessage('PDF descargado. Cuando tengás las tarjetas en papel, marcalas como impresas.');
  });
  const mark = cards => perform(async () => {
    // Recheck availability inside the transaction in case another admin or buyer used a code.
    const markedAt = new Date().toISOString();
    const changed = await runTransaction(db, async tx => {
      const docs = await Promise.all(cards.map(c=>tx.get(doc(db,'discountCodes',c.code))));
      const ready = docs.filter(s=>s.exists() && s.data().batchId===lot && cardState(s.data())==='Por imprimir');
      for (const s of ready) tx.update(s.ref,{printed:true,printedAt:markedAt});
      return ready.length;
    });
    setMessage(changed+' tarjeta(s) marcadas como impresas.');
  });
  return <main className="space-y-5">
    <Link to="/admin/crm" className="text-sm font-semibold text-rose-700">← CRM</Link>
    <h1 className="text-2xl font-black">Códigos de tarjetitas</h1>
    <p>Generá un lote de códigos de un solo uso. Vencen 60 días después de generarlos.</p>
    <form className="flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4" onSubmit={e=>{e.preventDefault();generate();}}>
      <label>Lote<input className="block rounded border p-2" required maxLength={50} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" placeholder="2026-11-A" value={batchId} onChange={e=>setBatchId(e.target.value)} /></label>
      <label>Cantidad<input className="block w-24 rounded border p-2" type="number" min="1" max="400" required value={count} onChange={e=>setCount(e.target.value)} /></label>
      <button className={button} disabled={busy}>Generar códigos</button>
    </form>
    <label className="block font-bold">Ver lote <select className="rounded border p-2" value={lot} onChange={e=>setSelected(e.target.value)}>
      {!lots.length && <option value="">Todavía no hay lotes</option>}{lots.map(b=><option key={b.id}>{b.id}</option>)}
    </select></label>
    <div className="flex flex-wrap gap-2">{states.map(s=><button key={s} aria-pressed={s===filter}
      className={'rounded-xl border px-3 py-2 '+(s===filter?'bg-rose-100 font-bold':'bg-white')} onClick={()=>setFilter(s)}>{s} ({rows.filter(r=>cardState(r)===s).length})</button>)}</div>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !pending.length} onClick={download}>Descargar PDF para imprimir</button>
      <button className="rounded-xl border bg-white px-4 py-2 disabled:opacity-50" disabled={busy || !pending.length} onClick={()=>mark(pending)}>Marcar pendientes del lote como impresos</button></div>
    {message && <p role="status" className="rounded-xl bg-rose-50 p-3">{message}</p>}
    {lot && loaded?.lot!==lot ? <p>Cargando códigos…</p> : !visible.length ? <p>No hay códigos en este filtro.</p> :
      <ul className="grid gap-3 sm:grid-cols-2">{visible.map(c=><li key={c.code} className="rounded-xl border bg-white p-4">
        <b className="font-mono text-lg">{c.code}</b><p>{cardState(c)} · Vence {date(c.expiresAt)}</p>
        {c.printedAt && <p>Impreso el {date(c.printedAt)}</p>}
        {c.used && <p>Usado el {date(c.usedAt)} · Pedido {c.orderId}</p>}
        {filter==='Por imprimir' && <button disabled={busy} className="my-2 text-rose-700 underline" onClick={()=>mark([c])}>Marcar como impreso</button>}
      </li>)}</ul>}
  </main>;
}
