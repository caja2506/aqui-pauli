import { useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';
import { normalizeCode } from '../../../functions/lib/promotions.mjs';

export default function CheckoutPromotion({ items, options, choice, setChoice, applied, onApply, onBusy }) {
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function apply() {
    onBusy(true); setBusy(true); setMessage('');
    try {
      const { data } = await httpsCallable(functions, 'validateDiscountCode')({ code: input,
        items: items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })) });
      if (data.ok) onApply({ code: normalizeCode(input), amount: data.amount });
      setMessage(data.message);
    } catch (error) { setMessage(error.code === 'functions/resource-exhausted' ? error.message : 'No se pudo validar el código. Volvé a probar.'); }
    finally { setBusy(false); onBusy(false); }
  }
  return <section className="space-y-5 rounded-2xl border border-rose-200 bg-rose-50 p-5">
    {options.length > 0 && <div>
      <label htmlFor="gift-decant" className="font-bold text-slate-900">🎁 Escogé tu muestra de regalo (3 ml)</label>
      <p className="my-2 text-sm text-slate-600">Es opcional. Si no escogés, te mandamos una sorpresa. Hasta agotar existencias.</p>
      <select id="gift-decant" className="w-full rounded-xl border p-3" value={choice} onChange={e => setChoice(e.target.value)}>
        <option value="sorpresa">🎁 Sorpresa (nosotros escogemos)</option>
        {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>}
    <div><label htmlFor="discount-code" className="font-bold text-slate-900">¿Tenés un código de descuento?</label>
      <div className="mt-2 flex gap-2"><input id="discount-code" className="min-w-0 flex-1 rounded-xl border p-3 uppercase" maxLength={24}
        value={applied?.code || input} disabled={busy || !!applied} onChange={e => { setInput(e.target.value); setMessage(''); }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (!busy && !applied && input.trim()) apply(); } }} placeholder="AP-XXXXXX" />
      <button type="button" className="rounded-xl bg-rose-700 px-4 font-bold text-white disabled:opacity-50" disabled={busy || (!applied && !input.trim())}
        onClick={applied ? () => { onApply(null); setInput(''); setMessage(''); } : apply}>{applied ? 'Quitar' : busy ? 'Validando…' : 'Aplicar'}</button></div>
      <p role="status" className="mt-1 text-sm">{applied ? 'Código aplicado: −10%' : message}</p>
    </div>
  </section>;
}
