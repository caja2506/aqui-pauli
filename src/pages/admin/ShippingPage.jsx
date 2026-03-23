import { useState, useEffect } from 'react';
import { Truck, Save, Loader2, RefreshCw } from 'lucide-react';
import { getShippingPrices, saveShippingPrices } from '../../services/shippingService';
import { formatCRC } from '../../utils/formatters';

export default function ShippingPage() {
  const [prices, setPrices] = useState({
    normalGAM: 3500,
    normalOutside: 5500,
    expressGrecia: 2000,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadPrices();
  }, []);

  const loadPrices = async () => {
    setLoading(true);
    try {
      const p = await getShippingPrices();
      setPrices(p);
    } catch (err) {
      console.error('Error cargando precios:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await saveShippingPrices(prices);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error('Error guardando precios:', err);
      alert('Error al guardar: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handlePriceChange = (key, value) => {
    const num = parseInt(value.replace(/\D/g, ''), 10) || 0;
    setPrices(prev => ({ ...prev, [key]: num }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="font-black text-2xl text-slate-800 tracking-tight flex items-center gap-2">
              <Truck className="w-6 h-6 text-indigo-600" /> Envíos
            </h2>
            <p className="text-sm text-slate-400 mt-1">Configurá los precios de envío a todo Costa Rica</p>
          </div>
          <button onClick={loadPrices} className="p-2 hover:bg-slate-100 rounded-xl transition-colors" title="Recargar">
            <RefreshCw className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* GAM */}
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl p-5 border border-blue-100">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
                <Truck className="w-4 h-4 text-white" />
              </div>
              <div>
                <h3 className="text-sm font-black text-slate-800">Normal GAM</h3>
                <p className="text-[10px] text-slate-400">Gran Área Metropolitana</p>
              </div>
            </div>
            <p className="text-[10px] text-slate-500 mb-2">Correos de CR · 2-4 días hábiles</p>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">₡</span>
              <input
                type="text"
                value={prices.normalGAM}
                onChange={e => handlePriceChange('normalGAM', e.target.value)}
                className="w-full pl-8 pr-4 py-3 bg-white border border-blue-200 rounded-xl text-lg font-black text-slate-900 outline-none focus:ring-2 focus:ring-blue-500 transition-all"
              />
            </div>
            <p className="text-[10px] text-blue-600 font-bold mt-2">{formatCRC(prices.normalGAM)}</p>
          </div>

          {/* Fuera GAM */}
          <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl p-5 border border-amber-100">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 bg-amber-600 rounded-xl flex items-center justify-center">
                <Truck className="w-4 h-4 text-white" />
              </div>
              <div>
                <h3 className="text-sm font-black text-slate-800">Normal Fuera GAM</h3>
                <p className="text-[10px] text-slate-400">Resto de Costa Rica</p>
              </div>
            </div>
            <p className="text-[10px] text-slate-500 mb-2">Correos de CR · 4-7 días hábiles</p>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">₡</span>
              <input
                type="text"
                value={prices.normalOutside}
                onChange={e => handlePriceChange('normalOutside', e.target.value)}
                className="w-full pl-8 pr-4 py-3 bg-white border border-amber-200 rounded-xl text-lg font-black text-slate-900 outline-none focus:ring-2 focus:ring-amber-500 transition-all"
              />
            </div>
            <p className="text-[10px] text-amber-600 font-bold mt-2">{formatCRC(prices.normalOutside)}</p>
          </div>

          {/* Express */}
          <div className="bg-gradient-to-br from-emerald-50 to-green-50 rounded-2xl p-5 border border-emerald-100">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 bg-emerald-600 rounded-xl flex items-center justify-center">
                <Truck className="w-4 h-4 text-white" />
              </div>
              <div>
                <h3 className="text-sm font-black text-slate-800">Express Grecia</h3>
                <p className="text-[10px] text-slate-400">Solo cantón de Grecia</p>
              </div>
            </div>
            <p className="text-[10px] text-slate-500 mb-2">Entrega directa · 1-2 días hábiles</p>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">₡</span>
              <input
                type="text"
                value={prices.expressGrecia}
                onChange={e => handlePriceChange('expressGrecia', e.target.value)}
                className="w-full pl-8 pr-4 py-3 bg-white border border-emerald-200 rounded-xl text-lg font-black text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
              />
            </div>
            <p className="text-[10px] text-emerald-600 font-bold mt-2">{formatCRC(prices.expressGrecia)}</p>
          </div>
        </div>

        {/* Guardar */}
        <div className="flex items-center justify-between mt-8 pt-6 border-t border-slate-100">
          <p className="text-xs text-slate-400">Los cambios se aplican de inmediato en el checkout</p>
          <button
            onClick={handleSave}
            disabled={saving}
            className={`flex items-center gap-2 px-6 py-3 rounded-2xl font-black text-sm transition-all active:scale-95 shadow-lg ${
              saved
                ? 'bg-green-500 text-white'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white'
            }`}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Save className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saving ? 'Guardando...' : saved ? '¡Guardado!' : 'Guardar Precios'}
          </button>
        </div>
      </div>
    </div>
  );
}
