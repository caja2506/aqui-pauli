import { useEffect, useMemo, useState, useRef } from 'react';
import { Calculator, Search, Upload, X, ArrowRight, Globe, Settings2, Loader2, Store, ChevronLeft, ChevronRight } from 'lucide-react';
import CopyButton from '../../components/ui/CopyButton';
import usePageTitle from '../../hooks/usePageTitle';
import { getPricingSettings, savePricingSettings, getSupplierCatalog, importSupplierCatalog, lookupExternalPrice, getPricingExchangeRate } from '../../services/pricingCalculatorService';
import { calculateSellingPrice, DEFAULT_PRICING_SETTINGS, PRICE_ROUNDING_STEPS, validateWorkbenchSettings, filterSupplierProducts, supplierPrice } from '../../utils/pricingCalculator';
import { formatCRC } from '../../utils/formatters';

const inputClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-900 outline-none focus:ring-2 focus:ring-rose-400 disabled:bg-slate-100';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed';
const money = value => new Intl.NumberFormat('es-CR', { style: 'currency', currency: 'CRC', maximumFractionDigits: 2 }).format(value);
const percent = value => value.toLocaleString('es-CR', { maximumFractionDigits: 1 });

function Field({ id, label, value, onChange, hint, min = 0, max = 1e9, readOnly = false }) {
  return <div><label htmlFor={id} className="block text-sm font-bold text-slate-700 mb-1.5">{label}</label>
    <input id={id} type="number" inputMode="decimal" min={min} max={max} step="any" value={value} readOnly={readOnly}
      onChange={event => onChange?.(event.target.value)} className={inputClass} aria-describedby={hint ? `${id}-hint` : undefined} />
    {hint && <p id={`${id}-hint`} className="text-xs text-slate-500 mt-1.5 leading-relaxed">{hint}</p>}</div>;
}

export function PricingBreakdown({ result }) {
  const parts = [
    { name: 'Compra', value: result.purchaseCRC, color: '#64748b' },
    { name: 'Traslado y entrega', value: result.inboundShipping + result.delivery, color: '#f59e0b' },
    { name: 'Otros costos', value: result.otherCosts, color: '#a78bfa' },
    { name: 'Ganancia', value: result.profit, color: '#059669' },
  ];
  let offset = 0;
  return <div className="flex flex-col sm:flex-row items-center gap-5">
    <svg viewBox="0 0 120 120" role="img" aria-label={`Distribución del precio: costo ${money(result.totalCost)} y ganancia ${money(result.profit)}`} className="w-36 h-36 shrink-0">
      <circle cx="60" cy="60" r="46" fill="none" stroke="#f1f5f9" strokeWidth="15" />
      {parts.map(part => {
        const share = part.value / result.suggestedPrice * 100;
        const start = offset; offset += share;
        return <circle key={part.name} cx="60" cy="60" r="46" pathLength="100" fill="none" stroke={part.color} strokeWidth="15"
          strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start} transform="rotate(-90 60 60)" />;
      })}
      <text x="60" y="57" textAnchor="middle" fill="#059669" fontSize="19" fontWeight="800">{percent(result.marginPercent)}%</text>
      <text x="60" y="73" textAnchor="middle" fill="#64748b" fontSize="9">margen de venta</text>
    </svg>
    <dl className="space-y-2 text-sm flex-1 w-full">{parts.map(part => <div key={part.name} className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-2 text-slate-600"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: part.color }} />{part.name}</dt>
      <dd className="font-bold whitespace-nowrap">{money(part.value)}</dd></div>)}</dl>
  </div>;
}

// El mismo detalle calcula productos del PDF, compras externas y productos manuales.
export function PricingCalculator({ product = null, mode = 'supplier', payment = 'cash', settings = DEFAULT_PRICING_SETTINGS, onClose,
  lookupPrice = lookupExternalPrice, fetchExchangeRate = getPricingExchangeRate }) {
  const international = mode === 'international';
  const initialCosts = () => ({ currency: international ? 'USD' : 'CRC', baseCost: product ? supplierPrice(product, payment) : '', exchangeRate: '',
    inboundShipping: international ? settings.internationalShippingCRC : settings.localShippingCRC, delivery: 0, otherCosts: 0 });
  const [costs, setCosts] = useState(initialCosts);
  const [markup, setMarkup] = useState(settings.markupPercent);
  const [name, setName] = useState(product?.description || '');
  const [url, setUrl] = useState('');
  const [lookup, setLookup] = useState(null);
  const [querying, setQuerying] = useState(false);
  const [fx, setFx] = useState({ loading: international, message: '' });
  const requestId = useRef(0);
  const fxEdited = useRef(false);
  const closeButton = useRef(null);
  const dialog = useRef(null);
  useEffect(() => {
    if (!onClose) return;
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => { previous?.focus?.(); };
  }, [onClose]);
  useEffect(() => {
    if (!international) return;
    let active = true;
    fetchExchangeRate().then(value => {
      if (!active) return;
      if (!fxEdited.current) setCosts(previous => ({ ...previous, exchangeRate: value.rate }));
      setFx({ loading: false, message: `Referencia: ${value.source}${value.date ? ` · ${value.date}` : ''}. Podés usar el tipo de cambio que te cobra tu banco.` });
    }).catch(() => { if (active) setFx({ loading: false, message: 'No pudimos cargar la referencia. Ingresá el tipo de cambio que te cobra tu banco.' }); });
    return () => { active = false; requestId.current += 1; };
  }, [international, fetchExchangeRate]);
  let result = null; let error = '';
  try { result = calculateSellingPrice(costs, { ...settings, markupPercent: markup }); } catch (failure) { error = failure.message; }
  const change = (key, value) => setCosts(previous => ({ ...previous, [key]: value }));
  const changeUrl = value => { requestId.current += 1; setUrl(value); if (lookup?.selectedId) setName(''); setLookup(null); setQuerying(false); change('baseCost', ''); };
  const consult = async () => {
    const id = ++requestId.current;
    setQuerying(true); if (lookup?.selectedId) { change('baseCost', ''); setName(''); } setLookup(null);
    try { const response = await lookupPrice(url); if (id === requestId.current) setLookup(response); }
    catch (failure) { if (id === requestId.current) setLookup({ offers: [], message: failure.message || 'No pudimos consultar el precio. Podés ingresarlo manualmente.' }); }
    finally { if (id === requestId.current) setQuerying(false); }
  };
  const applyOffer = offer => { setCosts(previous => ({ ...previous, baseCost: offer.amount, currency: offer.currency })); setName(offer.title); setLookup(previous => ({ ...previous, selectedId: offer.id })); };
  let safeLink = '';
  try { const parsed = new URL(url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) safeLink = parsed.href; } catch { /* incomplete link */ }
  const trapKeys = event => {
    if (event.key === 'Escape') onClose?.();
    if (event.key !== 'Tab' || !onClose) return;
    const controls = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')].filter(item => item.offsetParent !== null);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const body = <div ref={dialog} role={onClose ? 'dialog' : undefined} aria-modal={onClose ? true : undefined} aria-labelledby="pricing-detail-title"
    onKeyDown={trapKeys} className="bg-slate-50 rounded-3xl border border-slate-200 w-full max-w-6xl max-h-[94dvh] overflow-y-auto shadow-xl">
    <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-5 py-4 flex items-start gap-4 justify-between">
      <div className="min-w-0"><p className="text-xs font-bold text-rose-600 mb-1">{product ? `Proveedor LS · Mayorista ${payment === 'cash' ? 'efectivo' : 'SINPE/tarjeta'}` : international ? 'Compra internacional' : 'Otro producto nacional'}</p>
        <h2 id="pricing-detail-title" className="font-black text-lg md:text-xl leading-snug break-words">{product?.description || 'Calculá una nueva compra'}</h2>
        {product && <p className="text-xs text-slate-500 mt-1">Precio del PDF · página {product.page} · Confirmá disponibilidad con el proveedor.</p>}</div>
      {onClose && <button ref={closeButton} type="button" onClick={onClose} aria-label="Cerrar calculadora" className="p-2 rounded-xl hover:bg-slate-100 shrink-0"><X /></button>}
    </div>
    <div className="p-4 md:p-6 grid lg:grid-cols-2 gap-5 items-start">
      <div className="bg-white border border-slate-200 p-5 rounded-2xl space-y-4">
        {!product && <div><label htmlFor="product-name" className="block text-sm font-bold mb-1.5">Producto</label><input id="product-name" value={name} onChange={event => setName(event.target.value)} maxLength={240} className={inputClass} placeholder="Nombre y presentación" /></div>}
        {international && <div className="rounded-2xl bg-indigo-50 border border-indigo-100 p-4 space-y-3">
          <label htmlFor="external-url" className="block text-sm font-bold text-indigo-950">Enlace de la tienda</label>
          <input id="external-url" type="url" value={url} onChange={event => changeUrl(event.target.value)} className={inputClass} placeholder="https://www.amazon.com/…" maxLength={2048} />
          <div className="flex gap-3 flex-wrap"><button type="button" disabled={!url.trim() || querying} onClick={consult} className={buttonClass}>{querying && <Loader2 size={16} className="animate-spin" />}Consultar precio</button>
            {safeLink && <a href={safeLink} target="_blank" rel="noopener noreferrer" className="font-bold text-sm text-indigo-700 py-2">Abrir producto ↗</a>}</div>
          <p className="text-xs text-indigo-800 leading-relaxed">Consulta en Jomashop, FragranceNet y FragranceX cuando publican un precio legible. Amazon: enlace y precio manual por ahora. Para otra tienda podés pegar el enlace e ingresar el precio.</p>
          {lookup && <div role="status" className="text-sm text-slate-700 space-y-2"><p>{lookup.message}</p>
            {lookup.offers?.map(offer => <button key={offer.id} type="button" onClick={() => applyOffer(offer)} className={`w-full text-left p-3 rounded-xl border ${lookup.selectedId === offer.id ? 'bg-emerald-50 border-emerald-300' : 'bg-white border-slate-200'}`}>
              <span className="block text-xs">{offer.title}</span><strong>{offer.currency} {offer.amount.toLocaleString('es-CR')} · {lookup.selectedId === offer.id ? 'Seleccionado' : 'Usar este precio'}</strong></button>)}
            {lookup.checkedAt && <p className="text-xs">Consultado: {new Date(lookup.checkedAt).toLocaleString('es-CR')}</p>}</div>}
        </div>}
        {!product && <div><label htmlFor="purchase-currency" className="block text-sm font-bold mb-1.5">Moneda de compra</label><select id="purchase-currency" value={costs.currency} onChange={event => change('currency', event.target.value)} className={inputClass}><option value="CRC">Colones (CRC)</option><option value="USD">Dólares (USD)</option></select></div>}
        <Field id="base-cost" label={`Costo ${product ? 'mayorista' : 'de compra'} (${costs.currency})`} value={costs.baseCost} onChange={value => change('baseCost', value)} min={0.01} readOnly={!!product} />
        {costs.currency === 'USD' && <Field id="exchange-rate" label="Tipo de cambio (₡ por US$1)" value={costs.exchangeRate} min={0.01} max={100000}
          onChange={value => { fxEdited.current = true; change('exchangeRate', value); }} hint={fx.loading ? 'Consultando referencia de venta…' : fx.message || 'Ingresá el tipo de cambio que te cobra tu banco.'} />}
        <Field id="inbound-shipping" label={international ? 'Traslado internacional completo (₡)' : 'Envío del proveedor (₡)'} value={costs.inboundShipping} onChange={value => change('inboundShipping', value)}
          hint={international ? 'Incluye traslado a Costa Rica y movimiento interno hasta tu casa. No se suma el envío nacional de ₡2.900.' : 'Valor inicial ₡2.900 por cálculo. Si el envío cubre varias unidades, ingresá aquí la parte correspondiente.'} />
        <details className="rounded-xl border border-slate-100 p-3"><summary className="cursor-pointer text-sm font-bold text-slate-600">Otros costos y entrega al cliente</summary><div className="grid sm:grid-cols-2 gap-3 mt-3">
          <Field id="other-costs" label="Otros gastos (₡)" value={costs.otherCosts} onChange={value => change('otherCosts', value)} />
          <Field id="delivery" label="Entrega que asumís (₡)" value={costs.delivery} onChange={value => change('delivery', value)} hint="Solo si la paga Aquí Pauli." /></div></details>
        <Field id="markup-percent" label="Ganancia sobre costo (%)" value={markup} onChange={setMarkup} max={1000} hint="Ya incluye la ganancia estándar. Podés ajustarla para esta cotización." />
      </div>
      <section aria-label="Resumen del precio" className="bg-white rounded-2xl border border-slate-200 overflow-hidden lg:sticky lg:top-24">
        <div className="bg-slate-900 text-white p-6"><p className="text-sm text-rose-300 font-bold">Precio de venta sugerido</p><p aria-live="polite" className="text-4xl md:text-5xl font-black tracking-tight mt-2 break-words">{result ? formatCRC(result.suggestedPrice) : '—'}</p><p className="text-sm text-slate-300 mt-2 break-words">{name || 'Por unidad · en colones'}</p></div>
        <div className="p-5 space-y-5">{result ? <>
          <div className="grid grid-cols-2 gap-3"><div className="p-3 bg-slate-50 rounded-xl"><p className="text-xs text-slate-500">Costo total</p><p className="font-black text-lg">{money(result.totalCost)}</p></div><div className="p-3 bg-emerald-50 rounded-xl"><p className="text-xs text-emerald-700">Ganancia por unidad</p><p className="font-black text-lg text-emerald-800">{money(result.profit)}</p></div></div>
          <PricingBreakdown result={result} />
          <div className="border-t border-slate-100 pt-4 text-sm space-y-2"><p className="flex justify-between gap-3"><span className="text-slate-500">Precio antes de redondear</span><strong>{money(result.unroundedPrice)}</strong></p><p className="text-xs text-slate-500">Costo total + {markup}% de ganancia. Redondeo hacia arriba a {formatCRC(settings.roundingStep)}.</p></div>
          <CopyButton text={result.suggestedPrice} label="Copiar precio" ariaLabel="Copiar precio sugerido" />
        </> : <p role="status" className="p-4 bg-amber-50 text-amber-900 rounded-xl text-sm">{error}</p>}
        <p className="text-xs text-slate-500 leading-relaxed">La ganancia descuenta los gastos ingresados. El precio se puede copiar a Productos; esta cotización no modifica el catálogo de venta.</p></div>
      </section>
    </div>
  </div>;
  return onClose ? <div className="fixed inset-0 z-50 bg-slate-950/60 p-2 md:p-5 flex items-center justify-center">{body}</div> : body;
}

function PricingStandards({ settings, onSave }) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const change = (key, value) => { setDraft(previous => ({ ...previous, [key]: value })); setMessage(''); };
  const save = async event => {
    event.preventDefault(); setBusy(true); setMessage('');
    try { await onSave(validateWorkbenchSettings(draft)); setMessage('Estándar guardado para ambos administradores.'); }
    catch (error) { setMessage(error.message || 'No se pudo guardar.'); }
    finally { setBusy(false); }
  };
  return <details className="bg-white border border-slate-200 rounded-2xl p-4"><summary className="cursor-pointer text-sm font-bold flex items-center gap-2"><Settings2 size={17} /> Ajustar valores predeterminados</summary>
    <form onSubmit={save} className="mt-4 space-y-4"><fieldset disabled={busy} className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <Field id="standard-markup" label="Ganancia (%)" value={draft.markupPercent} onChange={value => change('markupPercent', value)} max={1000} />
      <Field id="standard-local" label="Envío nacional (₡)" value={draft.localShippingCRC} onChange={value => change('localShippingCRC', value)} />
      <Field id="standard-international" label="Traslado internacional (₡)" value={draft.internationalShippingCRC} onChange={value => change('internationalShippingCRC', value)} />
      <div><label htmlFor="standard-rounding" className="block text-sm font-bold mb-1.5">Redondeo hacia arriba</label><select id="standard-rounding" value={draft.roundingStep} onChange={event => change('roundingStep', event.target.value)} className={inputClass}>{PRICE_ROUNDING_STEPS.map(value => <option key={value} value={value}>{formatCRC(value)}</option>)}</select></div>
    </fieldset><button className={buttonClass} type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar estándar'}</button>{message && <p role="status" className="text-sm text-slate-600">{message}</p>}</form></details>;
}

export function SupplierPricingDashboard({ catalog, settings, onSettingsSave, onCatalogImport }) {
  const [query, setQuery] = useState('');
  const [payment, setPayment] = useState('cash');
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState(null);
  const [pending, setPending] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const filtered = useMemo(() => filterSupplierProducts(catalog?.products || [], query), [catalog, query]);
  const perPage = 40, pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const visible = filtered.slice(Math.min(page, pages - 1) * perPage, (Math.min(page, pages - 1) + 1) * perPage);
  const selectFile = async event => {
    setImportError(''); setPending(null);
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 800000) throw new Error('El archivo supera el tamaño permitido.');
      const value = JSON.parse(await file.text());
      if (value.version !== 1 || !Array.isArray(value.products) || !value.products.length || value.products.length > 3000) throw new Error('Seleccioná el archivo de catálogo preparado desde el PDF (.json).');
      setPending(value);
    } catch (error) { setImportError(error instanceof SyntaxError ? 'Seleccioná el catálogo preparado en formato .json.' : error.message); }
  };
  const confirmImport = async () => {
    setImporting(true); setImportError('');
    try { await onCatalogImport(pending); setPending(null); setPage(0); setQuery(''); }
    catch (error) { setImportError(error.message || 'No se pudo importar; el catálogo anterior permanece disponible.'); }
    finally { setImporting(false); }
  };
  return <div className="space-y-5">
    <div className="grid sm:grid-cols-3 gap-3">{[
      ['Ganancia sobre costo', `${settings.markupPercent}%`], ['Envío del proveedor nacional', formatCRC(settings.localShippingCRC)], ['Internacional hasta tu casa', formatCRC(settings.internationalShippingCRC)],
    ].map(([label, value]) => <div key={label} className="bg-white border border-slate-200 rounded-2xl p-4"><p className="text-xs text-slate-500 mb-1">{label}</p><p className="text-2xl font-black text-slate-900">{value}</p></div>)}</div>
    <div className="flex flex-wrap gap-3"><button type="button" onClick={() => setDetail({ mode: 'international' })} className={buttonClass}><Globe size={18} /> Compra internacional / enlace</button><button type="button" onClick={() => setDetail({ mode: 'manual' })} className="bg-white border border-slate-200 rounded-xl px-4 py-2.5 font-bold text-sm">Otro producto nacional</button></div>
    <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden" aria-labelledby="supplier-title">
      <div className="p-5 border-b border-slate-100 flex flex-wrap items-start justify-between gap-4"><div><h2 id="supplier-title" className="font-black text-xl flex items-center gap-2"><Store size={20} className="text-rose-600" /> Catálogo del proveedor LS</h2>
        <p className="text-xs text-slate-500 mt-2">{catalog ? `${catalog.products.length} productos · ${catalog.sourceName} · Precios sujetos a cambios sin previo aviso.` : 'Cargá el catálogo preparado desde el PDF para consultar todos los productos.'}</p></div>
        <label className="inline-flex items-center gap-2 text-sm font-bold border border-slate-200 px-3 py-2 rounded-xl cursor-pointer"><Upload size={16} />{catalog ? 'Actualizar catálogo' : 'Cargar catálogo'}<input aria-label="Importar catálogo del proveedor" type="file" accept=".json,application/json" disabled={importing} onChange={selectFile} className="sr-only" /></label>
      </div>
      {pending && <div className="m-5 p-4 rounded-xl bg-amber-50 border border-amber-200 text-sm space-y-3"><p><strong>{pending.products.length} productos</strong> de {pending.sourceName}. {catalog ? 'Reemplazará la lista del proveedor guardada.' : 'Se guardarán de forma privada para los administradores.'}</p><div className="flex gap-3"><button onClick={confirmImport} type="button" disabled={importing} className={buttonClass}>{importing ? 'Importando…' : catalog ? 'Reemplazar catálogo' : 'Importar productos'}</button><button type="button" onClick={() => setPending(null)} disabled={importing}>Cancelar</button></div></div>}
      {importError && <p role="alert" className="m-5 p-3 bg-red-50 text-red-700 rounded-xl text-sm">{importError}</p>}
      <div className="p-5 flex flex-col md:flex-row gap-3"><div className="relative flex-1"><Search size={17} className="absolute left-3 top-3.5 text-slate-400" /><input aria-label="Buscar en el catálogo del proveedor" type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Buscá por perfume, marca o presentación…" className={`${inputClass} pl-10`} /></div>
        <div className="md:w-64"><label htmlFor="supplier-payment" className="sr-only">Precio mayorista para calcular</label><select id="supplier-payment" value={payment} onChange={event => setPayment(event.target.value)} className={inputClass}><option value="cash">Mayorista: efectivo</option><option value="card">Mayorista: SINPE/tarjeta</option></select></div></div>
      <div className="overflow-x-auto"><table className="w-full text-sm min-w-[680px]"><thead className="text-xs text-slate-500 bg-slate-50"><tr><th className="text-left px-5 py-3">Descripción del PDF</th><th className={`text-right px-4 py-3 ${payment === 'cash' ? 'text-rose-700' : ''}`}>Mayorista<br />Efectivo</th><th className={`text-right px-4 py-3 ${payment === 'card' ? 'text-rose-700' : ''}`}>Mayorista<br />SINPE móvil o tarjeta</th><th className="px-4 py-3">Cálculo</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{visible.map(product => <tr key={product.id} className="hover:bg-rose-50/40"><td className="px-5 py-3"><button type="button" className="text-left font-semibold hover:text-rose-600" onClick={() => setDetail({ product, mode: 'supplier' })}>{product.description}</button>{product.cardCRC < product.cashCRC && <p className="text-xs text-amber-700 mt-1">SINPE/tarjeta figura más barato en el PDF. Confirmá con el proveedor.</p>}</td><td className="px-4 py-3 text-right whitespace-nowrap">{formatCRC(product.cashCRC)}</td><td className="px-4 py-3 text-right whitespace-nowrap">{formatCRC(product.cardCRC)}</td><td className="px-4 py-3"><button aria-label={`Calcular ${product.description}`} type="button" onClick={() => setDetail({ product, mode: 'supplier' })} className="inline-flex items-center gap-1 text-rose-600 font-bold">Calcular <ArrowRight size={15} /></button></td></tr>)}</tbody>
      </table></div>
      {!visible.length && <p className="text-center py-10 text-sm text-slate-500">{catalog ? 'No hay coincidencias. Podés calcularlo como otro producto o compra internacional.' : 'El catálogo todavía no está cargado. Las calculadoras nacional e internacional ya están disponibles.'}</p>}
      <div className="border-t border-slate-100 px-5 py-3 flex justify-between items-center gap-3 text-xs text-slate-500"><span>{filtered.length} productos · Página {Math.min(page + 1, pages)} de {pages}</span><div className="flex gap-2"><button aria-label="Página anterior" type="button" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))} className="p-2 border border-slate-200 rounded-lg disabled:opacity-30"><ChevronLeft size={16} /></button><button aria-label="Página siguiente" type="button" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)} className="p-2 border border-slate-200 rounded-lg disabled:opacity-30"><ChevronRight size={16} /></button></div></div>
    </section>
    <PricingStandards settings={settings} onSave={onSettingsSave} />
    {detail && <PricingCalculator key={`${detail.mode}-${detail.product?.id || 'new'}-${payment}`} {...detail} payment={payment} settings={settings} onClose={() => setDetail(null)} />}
  </div>;
}

export default function PricingPage() {
  usePageTitle('Proveedores y precios | Aquí Pauli Admin');
  const [state, setState] = useState({ loading: true, error: false, catalog: null, settings: null });
  const [request, setRequest] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([getPricingSettings(), getSupplierCatalog()]).then(([settings, catalog]) => {
      if (active) setState({ loading: false, error: false, settings, catalog });
    }).catch(() => { if (active) setState({ loading: false, error: true, catalog: null, settings: null }); });
    return () => { active = false; };
  }, [request]);
  const save = async settings => { const saved = await savePricingSettings(settings); setState(previous => ({ ...previous, settings: saved })); return saved; };
  const upload = async catalog => {
    await importSupplierCatalog(catalog);
    const saved = await getSupplierCatalog();
    if (!saved) throw new Error('No pudimos confirmar la carga. Recargá la página para revisar el catálogo.');
    setState(previous => ({ ...previous, catalog: saved }));
  };
  return <div className="max-w-7xl mx-auto space-y-6 pb-8"><header><h1 className="text-2xl md:text-3xl font-black tracking-tight flex items-center gap-3"><Calculator className="text-rose-600 shrink-0" /> Proveedores y precios</h1><p className="text-sm text-slate-500 mt-2">Elegí un producto y mirá cuánto cuesta traerlo, a cuánto venderlo y cuánto ganás.</p></header>
    {state.loading ? <p role="status" className="flex items-center gap-2 text-slate-500 py-8"><Loader2 className="animate-spin" /> Cargando proveedores y precios…</p> : state.error ? <div role="alert" className="p-5 rounded-2xl bg-red-50 border border-red-200 text-red-800 text-sm"><p>No pudimos cargar el catálogo y los valores guardados.</p><button type="button" onClick={() => { setState(previous => ({ ...previous, loading: true })); setRequest(value => value + 1); }} className="font-bold underline mt-3">Reintentar</button></div> : <SupplierPricingDashboard catalog={state.catalog} settings={state.settings} onSettingsSave={save} onCatalogImport={upload} />}
  </div>;
}
