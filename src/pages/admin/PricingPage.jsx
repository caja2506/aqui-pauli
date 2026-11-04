import { useEffect, useState } from 'react';
import { Calculator, Save, Loader2, RotateCcw } from 'lucide-react';
import CopyButton from '../../components/ui/CopyButton';
import usePageTitle from '../../hooks/usePageTitle';
import { getPricingSettings, savePricingSettings } from '../../services/pricingCalculatorService';
import { calculateSellingPrice, PRICE_ROUNDING_STEPS, validatePricingSettings } from '../../utils/pricingCalculator';
import { formatCRC } from '../../utils/formatters';

const emptyCosts = () => ({ productName: '', currency: 'CRC', baseCost: '', exchangeRate: '', inboundShipping: '', delivery: '', otherCosts: '' });
const inputClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base text-slate-900 outline-none focus:ring-2 focus:ring-rose-400 disabled:bg-slate-100';
const money = value => new Intl.NumberFormat('es-CR', { style: 'currency', currency: 'CRC', maximumFractionDigits: 2 }).format(value);

function NumberField({ id, label, value, onChange, hint, min = '0', max = '1000000000', placeholder = '0', required = false }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-bold text-slate-700 mb-2">{label}</label>
      <input id={id} type="number" inputMode="decimal" min={min} max={max} step="any" value={value}
        onChange={e => onChange(e.target.value)} placeholder={placeholder} required={required}
        aria-describedby={hint ? `${id}-hint` : undefined} className={inputClass} />
      {hint && <p id={`${id}-hint`} className="mt-1.5 text-xs leading-relaxed text-slate-500">{hint}</p>}
    </div>
  );
}

export function PricingCalculator({ initialSettings, onSaveSettings }) {
  const [costs, setCosts] = useState(emptyCosts);
  const [settings, setSettings] = useState(initialSettings || { markupPercent: '', roundingStep: 100 });
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const changeCost = (key, value) => setCosts(previous => ({ ...previous, [key]: value }));
  const changeSetting = (key, value) => {
    setSettings(previous => ({ ...previous, [key]: value }));
    setFeedback(null);
  };
  let result = null;
  let calculationError = '';
  let validSettings = null;
  try { validSettings = validatePricingSettings(settings); } catch { /* displayed beside the calculation */ }
  try { result = calculateSellingPrice(costs, settings); } catch (error) { calculationError = error.message; }
  const dirty = !savedSettings || !validSettings || savedSettings.markupPercent !== validSettings.markupPercent
    || savedSettings.roundingStep !== validSettings.roundingStep;

  const handleSave = async event => {
    event.preventDefault();
    if (!validSettings || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const saved = await onSaveSettings(validSettings);
      setSavedSettings(saved);
      setFeedback({ error: false, text: 'Ganancia estándar guardada para todos los administradores.' });
    } catch {
      setFeedback({ error: true, text: 'No se pudo guardar. Revisá la conexión e intentá de nuevo; tus valores siguen en pantalla.' });
    } finally { setSaving(false); }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-6 items-start">
      <div className="space-y-6 min-w-0">
        <section className="bg-white rounded-3xl border border-slate-200 p-5 md:p-6 shadow-sm" aria-labelledby="costs-title">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 id="costs-title" className="font-black text-lg">1. Costos del producto</h2>
            <button type="button" onClick={() => setCosts(emptyCosts())} className="flex items-center gap-1.5 text-sm font-bold text-slate-500 hover:text-rose-600 py-2">
              <RotateCcw size={15} aria-hidden="true" /> Limpiar
            </button>
          </div>
          <p className="text-sm text-slate-500 mb-5">Ingresá los costos de una unidad. Si el envío cubre varias piezas, usá la parte que corresponde a esta unidad.</p>
          <div className="space-y-5">
            <div>
              <label htmlFor="product-name" className="block text-sm font-bold text-slate-700 mb-2">Producto (opcional)</label>
              <input id="product-name" value={costs.productName} onChange={e => changeCost('productName', e.target.value)}
                maxLength={150} placeholder="Ej. Light Blue Intense 100 ml" className={inputClass} />
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="purchase-currency" className="block text-sm font-bold text-slate-700 mb-2">Moneda de compra</label>
                <select id="purchase-currency" value={costs.currency} onChange={e => changeCost('currency', e.target.value)} className={inputClass}>
                  <option value="CRC">Colones (CRC)</option><option value="USD">Dólares (USD)</option>
                </select>
              </div>
              <NumberField id="base-cost" label={`Costo base (${costs.currency === 'USD' ? 'USD $' : 'CRC ₡'})`} value={costs.baseCost}
                onChange={value => changeCost('baseCost', value)} min="0.01" placeholder="Ingresá el costo" required />
            </div>
            {costs.currency === 'USD' && <NumberField id="exchange-rate" label="Tipo de cambio (₡ por US$1)" value={costs.exchangeRate}
              onChange={value => changeCost('exchangeRate', value)} min="0.01" max="100000" placeholder="Ingresá el tipo de cambio" required
              hint="Usá el tipo de cambio que te cobraron. La conversión aplica al costo base; los demás costos van en colones." />}
            <NumberField id="inbound-shipping" label="Envío del proveedor / importación (₡)" value={costs.inboundShipping}
              onChange={value => changeCost('inboundShipping', value)} hint="Costo de traer una unidad hasta Aquí Pauli." />
            <NumberField id="customer-delivery" label="Entrega al cliente que asumís (₡)" value={costs.delivery}
              onChange={value => changeCost('delivery', value)} hint="Incluí solo lo que paga la tienda. Si el cliente lo paga aparte, dejalo en 0." />
            <NumberField id="other-costs" label="Otros costos por unidad (₡)" value={costs.otherCosts}
              onChange={value => changeCost('otherCosts', value)} hint="Empaque, impuestos de compra u otros gastos que ya conocés." />
          </div>
        </section>

        <form onSubmit={handleSave} className="bg-white rounded-3xl border border-slate-200 p-5 md:p-6 shadow-sm" aria-labelledby="standard-title">
          <h2 id="standard-title" className="font-black text-lg mb-2">2. Ganancia estándar</h2>
          <p className="text-sm text-slate-500 mb-5">Guardá una regla para calcular perfumes, decants, bolsos, zapatos o cualquier producto.</p>
          <fieldset disabled={saving} className="space-y-4">
            <NumberField id="markup-percent" label="Ganancia sobre el costo total (%)" value={settings.markupPercent} max="1000"
              onChange={value => changeSetting('markupPercent', value)} placeholder="Definí tu porcentaje" required
              hint="Ejemplo: costo ₡10.000 + 30% de ganancia = precio ₡13.000. El 30% es un ejemplo; elegí tu estándar." />
            <div>
              <label htmlFor="rounding-step" className="block text-sm font-bold text-slate-700 mb-2">Redondear el precio hacia arriba</label>
              <select id="rounding-step" value={settings.roundingStep} onChange={e => changeSetting('roundingStep', e.target.value)} className={inputClass}>
                {PRICE_ROUNDING_STEPS.map(step => <option key={step} value={step}>{step === 1 ? 'Al siguiente colón' : `Al siguiente múltiplo de ${formatCRC(step)}`}</option>)}
              </select>
            </div>
            <button type="submit" disabled={!validSettings || !dirty || saving}
              className="w-full sm:w-auto flex justify-center items-center gap-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm px-5 py-3 rounded-xl">
              {saving ? <Loader2 className="animate-spin w-4 h-4" /> : <Save className="w-4 h-4" />}
              {saving ? 'Guardando…' : 'Guardar estándar'}
            </button>
          </fieldset>
          <p className="text-xs text-slate-500 mt-3">{dirty ? 'Los valores en pantalla aún no están guardados como estándar.' : 'Estándar guardado. Se usará al volver a abrir esta pantalla.'}</p>
          {feedback && <p role={feedback.error ? 'alert' : 'status'} className={`text-sm mt-3 ${feedback.error ? 'text-red-700' : 'text-emerald-700'}`}>{feedback.text}</p>}
        </form>
      </div>

      <section className="min-w-0 xl:sticky xl:top-0 bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm" aria-labelledby="result-title">
        <div className="bg-slate-900 text-white p-6">
          <h2 id="result-title" className="text-sm font-bold text-rose-300">Precio de venta sugerido</h2>
          <p className="text-4xl md:text-5xl font-black tracking-tight mt-3 break-words" aria-live="polite" aria-atomic="true">{result ? formatCRC(result.suggestedPrice) : '—'}</p>
          <p className="text-sm text-slate-300 mt-3 break-words">{costs.productName || 'Por unidad · en colones'}</p>
        </div>
        <div className="p-5 md:p-6 space-y-5">
          {result ? <>
            <dl className="space-y-3 text-sm">
              {[
                ['Costo base en colones', result.purchaseCRC],
                ['Envío del proveedor', result.inboundShipping],
                ['Entrega al cliente', result.delivery],
                ['Otros costos', result.otherCosts],
              ].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-slate-500">{label}</dt><dd className="font-semibold text-right">{money(value)}</dd></div>)}
              <div className="flex justify-between gap-4 border-t border-slate-100 pt-3 font-black"><dt>Costo total</dt><dd className="text-right">{money(result.totalCost)}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-slate-500">Ganancia objetivo ({settings.markupPercent}%)</dt><dd className="font-semibold text-right">{money(result.targetProfit)}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-slate-500">Precio antes de redondear</dt><dd className="font-semibold text-right">{money(result.unroundedPrice)}</dd></div>
            </dl>
            <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4">
              <p className="text-sm font-bold text-emerald-800">Ganancia por unidad con este precio</p>
              <p className="text-2xl font-black text-emerald-800 mt-1">{money(result.profit)}</p>
              <p className="text-xs text-emerald-700 mt-1">Equivale al {result.marginPercent.toLocaleString('es-CR', { maximumFractionDigits: 1 })}% del precio de venta.</p>
            </div>
            <CopyButton text={result.suggestedPrice} label="Copiar precio" ariaLabel="Copiar precio sugerido en colones" />
          </> : <p role="status" className="text-sm text-slate-600 bg-slate-50 rounded-xl p-4">{calculationError}</p>}
          <p className="text-xs leading-relaxed text-slate-500">Precio = costo total × (1 + ganancia / 100), redondeado hacia arriba. La ganancia mostrada descuenta los costos ingresados; agregá cualquier gasto adicional que debás cubrir.</p>
          <p className="text-xs leading-relaxed text-slate-500">Podés copiar el resultado al editar un producto. Esta calculadora no cambia precios del catálogo ni cargos del checkout.</p>
        </div>
      </section>
    </div>
  );
}

export default function PricingPage() {
  usePageTitle('Calculadora de precios | Aquí Pauli Admin');
  const [request, setRequest] = useState(0);
  const [state, setState] = useState({ loading: true, error: false, settings: null });
  useEffect(() => {
    let active = true;
    getPricingSettings().then(settings => {
      if (active) setState({ loading: false, error: false, settings });
    }).catch(() => {
      if (active) setState({ loading: false, error: true, settings: null });
    });
    return () => { active = false; };
  }, [request]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-6">
      <header>
        <h1 className="text-2xl md:text-3xl font-black tracking-tight flex items-center gap-3"><Calculator className="text-rose-600 shrink-0" /> Calculadora de precios</h1>
        <p className="text-sm text-slate-500 mt-2">Sumá tus costos y calculá un precio con la misma regla de ganancia para toda la tienda.</p>
      </header>
      {state.loading ? <p role="status" className="flex items-center gap-2 text-slate-500 py-8"><Loader2 className="animate-spin" /> Cargando estándar…</p>
        : state.error ? <div role="alert" className="p-5 rounded-2xl border border-red-200 bg-red-50 text-sm text-red-800">
          <p>No pudimos cargar la ganancia estándar. Intentá de nuevo para usar la configuración guardada.</p>
          <button type="button" onClick={() => { setState({ loading: true, error: false, settings: null }); setRequest(value => value + 1); }} className="mt-3 font-bold underline">Reintentar</button>
        </div>
          : <PricingCalculator initialSettings={state.settings} onSaveSettings={savePricingSettings} />}
    </div>
  );
}
