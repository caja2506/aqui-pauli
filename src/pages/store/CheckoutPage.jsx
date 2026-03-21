import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, CreditCard, Smartphone, Building, ShoppingBag } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useCart } from '../../contexts/CartContext';
import { formatCRC } from '../../utils/formatters';
import { PAYMENT_METHOD_LABELS } from '../../utils/constants';
import { getProvincias, getCantones, getDistritos, buscarPorCodigoPostal } from '../../data/costaRicaTerritorial';
import { calculateShippingCost, getShippingOptions } from '../../services/shippingService';
import { createOrder } from '../../services/orderService';
import LoadingSpinner from '../../components/ui/LoadingSpinner';

export default function CheckoutPage() {
  const { user } = useAuth();
  const { items, subtotal, clearCart } = useCart();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: user?.displayName || '',
    email: user?.email || '',
    phone: '',
    provincia: '',
    canton: '',
    distrito: '',
    codigoPostal: '',
    señas: '',
    paymentMethod: '',
    shippingType: 'normal',
    paymentPhone: '',
  });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  // Redirect if not logged in
  if (!user) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <ShoppingBag className="w-12 h-12 text-slate-300 mx-auto mb-4" />
        <h2 className="text-xl font-black text-slate-900 mb-2">Inicia sesión para comprar</h2>
        <p className="text-sm text-slate-400 mb-6">Necesitas una cuenta para completar tu compra</p>
        <Link to="/login" state={{ from: '/checkout' }} className="inline-flex items-center gap-2 px-6 py-3 bg-rose-600 text-white font-bold rounded-xl shadow-lg active:scale-95 transition-all text-sm">
          Iniciar Sesión
        </Link>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <ShoppingBag className="w-12 h-12 text-slate-300 mx-auto mb-4" />
        <h2 className="text-xl font-black text-slate-900 mb-2">Tu carrito está vacío</h2>
        <Link to="/catalogo" className="text-sm font-bold text-rose-600">← Ir al catálogo</Link>
      </div>
    );
  }

  const shippingCost = form.canton ? calculateShippingCost(form.canton, form.shippingType) : 0;
  const total = subtotal + shippingCost;
  const shippingOptions = form.canton ? getShippingOptions(form.canton) : [];

  // Territorial data
  const provincias = getProvincias();
  const cantones = form.provincia ? getCantones(form.provincia) : [];
  const distritos = form.provincia && form.canton ? getDistritos(form.provincia, form.canton) : [];

  const handleChange = (field, value) => {
    const updates = { [field]: value };

    // Cascade resets
    if (field === 'provincia') {
      updates.canton = '';
      updates.distrito = '';
      updates.codigoPostal = '';
    }
    if (field === 'canton') {
      updates.distrito = '';
      updates.codigoPostal = '';
    }
    if (field === 'distrito' && value) {
      const found = distritos.find(d => d.distrito === value);
      if (found) updates.codigoPostal = found.codigo;
    }

    setForm(prev => ({ ...prev, ...updates }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }));
  };

  const handleCodigoPostal = (codigo) => {
    const clean = codigo.replace(/\D/g, '').slice(0, 5);
    setForm(prev => ({ ...prev, codigoPostal: clean }));

    if (clean.length === 5) {
      const result = buscarPorCodigoPostal(clean);
      if (result) {
        setForm(prev => ({
          ...prev,
          provincia: result.provincia,
          canton: result.canton,
          distrito: result.distrito,
          codigoPostal: result.codigo,
        }));
        setErrors(prev => ({ ...prev, provincia: null, canton: null, distrito: null }));
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const newErrors = {};
    if (!form.name.trim()) newErrors.name = 'Nombre requerido';
    if (!form.phone.trim()) newErrors.phone = 'Teléfono requerido';
    if (!form.provincia) newErrors.provincia = 'Selecciona provincia';
    if (!form.canton) newErrors.canton = 'Cantón requerido';
    if (!form.distrito) newErrors.distrito = 'Distrito requerido';
    if (!form.señas.trim()) newErrors.señas = 'Señas requeridas';
    if (!form.paymentMethod) newErrors.paymentMethod = 'Selecciona método de pago';
    if (form.paymentMethod === 'sinpe' && !form.paymentPhone.trim()) {
      newErrors.paymentPhone = 'Teléfono de SINPE requerido';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSubmitting(true);
    try {
      const result = await createOrder({
        uid: user.uid,
        customerEmail: form.email,
        customerName: form.name,
        customerPhone: form.phone,
        paymentMethod: form.paymentMethod,
        paymentPhone: form.paymentPhone,
        subtotal,
        shippingCost,
        shippingType: form.shippingType,
        shippingAddress: {
          provincia: form.provincia,
          canton: form.canton,
          distrito: form.distrito,
          codigoPostal: form.codigoPostal,
          señas: form.señas,
        },
        items: items.map(i => ({
          productId: i.productId,
          variantId: i.variantId,
          productName: i.productName,
          variantName: i.variantName,
          imageUrl: i.imageUrl,
          price: i.price,
          quantity: i.quantity,
          supplyType: i.supplyType,
        })),
      });

      clearCart();
      navigate(`/orden-confirmada/${result.orderId}`, { state: { orderNumber: result.orderNumber, total, paymentMethod: form.paymentMethod } });
    } catch (err) {
      console.error('Error creating order:', err);
      const errorMessage = err?.code === 'functions/failed-precondition'
        ? err.message || 'Stock insuficiente para uno o más productos.'
        : err?.code === 'functions/unauthenticated'
          ? 'Tu sesión expiró. Por favor inicia sesión de nuevo.'
          : 'Error al crear el pedido. Intenta de nuevo.';
      setErrors({ submit: errorMessage });
      setSubmitting(false);
    }
  };

  const paymentIcons = { paypal: CreditCard, sinpe: Smartphone, transferencia: Building };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <Link to="/carrito" className="inline-flex items-center gap-1 text-sm font-bold text-rose-600 hover:text-rose-700 mb-6">
        <ArrowLeft className="w-4 h-4" /> Volver al carrito
      </Link>

      <h1 className="text-2xl font-black text-slate-900 tracking-tight mb-8">Checkout</h1>

      {errors.submit && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-600 font-bold">{errors.submit}</div>
      )}

      <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Form */}
        <div className="lg:col-span-2 space-y-6">
          {/* Contact */}
          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-4">
            <h2 className="font-black text-lg text-slate-900">Datos de Contacto</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nombre completo</label>
                <input value={form.name} onChange={e => handleChange('name', e.target.value)} className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 ${errors.name ? 'border-red-300 bg-red-50' : 'border-slate-200'}`} />
                {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Teléfono</label>
                <input value={form.phone} onChange={e => handleChange('phone', e.target.value)} placeholder="8888-8888" className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 ${errors.phone ? 'border-red-300 bg-red-50' : 'border-slate-200'}`} />
                {errors.phone && <p className="text-xs text-red-500 mt-1">{errors.phone}</p>}
              </div>
            </div>
          </div>

          {/* Address */}
          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-4">
            <h2 className="font-black text-lg text-slate-900">Dirección de Envío</h2>

            {/* Código Postal shortcut */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-3">
              <div className="shrink-0">
                <span className="text-lg">📮</span>
              </div>
              <div className="flex-1">
                <label className="text-[10px] font-bold text-amber-600 uppercase block mb-1">Código Postal (auto-llena dirección)</label>
                <input
                  value={form.codigoPostal}
                  onChange={e => handleCodigoPostal(e.target.value)}
                  placeholder="Ej: 10301"
                  maxLength={5}
                  className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm font-mono font-bold outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Provincia</label>
                <select value={form.provincia} onChange={e => handleChange('provincia', e.target.value)} className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 ${errors.provincia ? 'border-red-300' : 'border-slate-200'}`}>
                  <option value="">Seleccionar...</option>
                  {provincias.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                {errors.provincia && <p className="text-xs text-red-500 mt-1">{errors.provincia}</p>}
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Cantón</label>
                <select
                  value={form.canton}
                  onChange={e => handleChange('canton', e.target.value)}
                  disabled={!form.provincia}
                  className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 disabled:bg-slate-50 disabled:text-slate-300 ${errors.canton ? 'border-red-300' : 'border-slate-200'}`}
                >
                  <option value="">Seleccionar...</option>
                  {cantones.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                {errors.canton && <p className="text-xs text-red-500 mt-1">{errors.canton}</p>}
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Distrito</label>
                <select
                  value={form.distrito}
                  onChange={e => handleChange('distrito', e.target.value)}
                  disabled={!form.canton}
                  className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 disabled:bg-slate-50 disabled:text-slate-300 ${errors.distrito ? 'border-red-300' : 'border-slate-200'}`}
                >
                  <option value="">Seleccionar...</option>
                  {distritos.map(d => <option key={d.codigo} value={d.distrito}>{d.distrito}</option>)}
                </select>
                {errors.distrito && <p className="text-xs text-red-500 mt-1">{errors.distrito}</p>}
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Señas exactas</label>
              <textarea value={form.señas} onChange={e => handleChange('señas', e.target.value)} rows={3} placeholder="Casa color verde, 200m norte del supermercado..." className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 resize-none ${errors.señas ? 'border-red-300' : 'border-slate-200'}`} />
            </div>

            {/* Shipping Options */}
            {shippingOptions.length > 0 && (
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Tipo de envío</label>
                {shippingOptions.map(opt => (
                  <label key={opt.type} className={`flex items-center justify-between p-4 rounded-xl border cursor-pointer transition-all ${form.shippingType === opt.type ? 'border-rose-400 bg-rose-50' : 'border-slate-200 hover:border-rose-200'}`}>
                    <div className="flex items-center gap-3">
                      <input type="radio" name="shipping" value={opt.type} checked={form.shippingType === opt.type} onChange={() => handleChange('shippingType', opt.type)} className="accent-rose-600" />
                      <div>
                        <p className="text-sm font-bold text-slate-900">{opt.label}</p>
                        <p className="text-xs text-slate-400">{opt.estimatedDays}</p>
                      </div>
                    </div>
                    <span className="text-sm font-black text-rose-600">{formatCRC(opt.price)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Payment */}
          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-4">
            <h2 className="font-black text-lg text-slate-900">Método de Pago</h2>
            {errors.paymentMethod && <p className="text-xs text-red-500">{errors.paymentMethod}</p>}
            <div className="space-y-2">
              {Object.entries(PAYMENT_METHOD_LABELS).map(([key, label]) => {
                const Icon = paymentIcons[key] || CreditCard;
                return (
                  <label key={key} className={`flex items-center gap-3 p-4 rounded-xl border cursor-pointer transition-all ${form.paymentMethod === key ? 'border-rose-400 bg-rose-50' : 'border-slate-200 hover:border-rose-200'}`}>
                    <input type="radio" name="payment" value={key} checked={form.paymentMethod === key} onChange={() => handleChange('paymentMethod', key)} className="accent-rose-600" />
                    <Icon className="w-5 h-5 text-slate-500" />
                    <span className="text-sm font-bold text-slate-900">{label}</span>
                  </label>
                );
              })}
            </div>
            {form.paymentMethod === 'sinpe' && (
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Teléfono SINPE (el mismo con que pagarás)</label>
                <input value={form.paymentPhone} onChange={e => handleChange('paymentPhone', e.target.value)} placeholder="8888-8888" className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 ${errors.paymentPhone ? 'border-red-300' : 'border-slate-200'}`} />
              </div>
            )}
          </div>
        </div>

        {/* Summary */}
        <div className="lg:col-span-1">
          <div className="sticky top-24 bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-4">
            <h2 className="font-black text-lg text-slate-900">Resumen</h2>
            <div className="space-y-3 max-h-60 overflow-y-auto">
              {items.map(item => (
                <div key={`${item.productId}-${item.variantId}`} className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-lg bg-slate-50 border border-slate-200 overflow-hidden shrink-0">
                    {item.imageUrl ? <img src={item.imageUrl} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-slate-900 truncate">{item.productName}</p>
                    <p className="text-[10px] text-slate-400">{item.variantName} × {item.quantity}</p>
                  </div>
                  <span className="text-xs font-bold text-slate-700">{formatCRC(item.price * item.quantity)}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-slate-100 pt-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Subtotal</span>
                <span className="font-bold">{formatCRC(subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Envío</span>
                <span className="font-bold">{form.canton ? formatCRC(shippingCost) : '—'}</span>
              </div>
              <div className="flex justify-between text-lg pt-2 border-t border-slate-100">
                <span className="font-black text-slate-900">Total</span>
                <span className="font-black text-rose-600">{formatCRC(total)}</span>
              </div>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-4 bg-rose-600 hover:bg-rose-700 text-white font-black rounded-2xl transition-all shadow-lg active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              {submitting ? 'Procesando...' : `Confirmar Pedido · ${formatCRC(total)}`}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
