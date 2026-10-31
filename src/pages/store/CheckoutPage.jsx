import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, CreditCard, ShoppingBag, ShieldCheck } from 'lucide-react';
import SaveAccountPrompt from '../../components/auth/SaveAccountPrompt';
import { useAuth } from '../../contexts/AuthContext';
import { useCart } from '../../contexts/CartContext';
import { formatCRC } from '../../utils/formatters';
import { listPaymentMethods, getPaymentMethod, isOnlineMethod, isCashOnDeliveryEligible, ONLINE_PROVIDERS } from '../../services/payments/registry';
import { getProvincias, getCantones, getDistritos, buscarPorCodigoPostal } from '../../data/costaRicaTerritorial';
import { calculateShippingCost, getShippingOptions } from '../../services/shippingService';
import { createOrder } from '../../services/orderService';
import { createPaypalPendingOrder } from '../../services/payments/paypalClient';
import { createCashOnDeliveryOrder } from '../../services/payments/cashOnDeliveryClient';
import { backorderFromPaypalQuote, paypalQuoteKey } from '../../services/payments/paypalQuote';
import { backorderFromTilopayQuote, tilopayQuoteKey } from '../../services/payments/tilopayQuote';
import { computeBackorder, BACKORDER_DEPOSIT_LABEL, BACKORDER_BALANCE_TIMING } from '../../utils/backorder';
import { SINPE_INFO } from '../../utils/constants';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import LoadingSpinner from '../../components/ui/LoadingSpinner';
import usePageTitle from '../../hooks/usePageTitle';
import { GIVEAWAY_PHONE_ERROR, isValidGiveawayPhone } from '../../../functions/lib/giveawayPhone.mjs';

// Mensajes de validación públicos del callable. Los errores desconocidos no se
// muestran íntegros, para no presentar detalles internos al comprador.
const CASH_VALIDATION_MESSAGES = new Set([
  'Ingresá tu nombre completo para coordinar la entrega.',
  'Ingresá un correo válido para coordinar la entrega.',
  GIVEAWAY_PHONE_ERROR,
  'Completá provincia, cantón, distrito y señas exactas para la entrega.',
  'Las notas del pedido deben ser texto.',
  'Las notas del pedido pueden tener hasta 1000 caracteres.',
]);

export default function CheckoutPage() {
  usePageTitle('Checkout | Aquí Pauli');
  const { user, loading: authLoading, ensureGuestSession } = useAuth();
  const [guestError, setGuestError] = useState(null);
  const { items, subtotal, clearCart } = useCart();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: user?.displayName || '',
    email: user?.email || '',
    phone: '',
    cedula: '',
    provincia: '',
    canton: '',
    distrito: '',
    codigoPostal: '',
    señas: '',
    paymentMethod: '',
    shippingType: 'normal',
    paymentPhone: '',
    customerNotes: '',
  });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  // Disponibilidad de pasarelas online (PayPal, a futuro Tilopay)
  const [availability, setAvailability] = useState({});
  const [paypalQuote, setPaypalQuote] = useState(null);
  const [tilopayQuote, setTilopayQuote] = useState(null);
  // Pedido pendiente ya creado para el intento de pago online actual (evita duplicados)
  const pendingOrderRef = useRef(null);
  const submittingRef = useRef(false);
  const cashOnDeliveryEligible = isCashOnDeliveryEligible(items);
  const invalidCashOnDeliverySelection = form.paymentMethod === 'contra_entrega' && !cashOnDeliveryEligible;
  // Derivar la selección válida evita mostrar un radio activo o aceptar un
  // envío antes de que un efecto alcance a reaccionar al cambio del carrito.
  const selectedPaymentMethod = invalidCashOnDeliverySelection ? '' : form.paymentMethod;

  useEffect(() => {
    let cancelled = false;
    Object.values(ONLINE_PROVIDERS).forEach(async (p) => {
      const a = await p.getAvailability();
      if (!cancelled) setAvailability(prev => ({ ...prev, [p.id]: a }));
    });
    return () => { cancelled = true; };
  }, []);

  // Compra como invitado: si no hay sesión, abrimos una sesión anónima (uid propio para el pedido)
  useEffect(() => {
    if (authLoading || user || items.length === 0) return;
    ensureGuestSession().catch((err) => {
      console.error('Guest session error:', err);
      setGuestError('No pudimos iniciar tu compra como invitado. Revisá tu conexión e intentá de nuevo.');
    });
  }, [authLoading, user, items.length]);

  // Cargar datos del CRM para pre-llenar
  useEffect(() => {
    if (!user?.uid || user.isAnonymous) return;
    const loadCrmData = async () => {
      try {
        const crmDoc = await getDoc(doc(db, 'crm_contacts', user.uid));
        if (crmDoc.exists()) {
          const crm = crmDoc.data();
          setForm(prev => ({
            ...prev,
            name: crm.displayName || prev.name,
            email: crm.email || prev.email,
            phone: crm.phone || prev.phone,
            cedula: crm.cedula || '',
            provincia: crm.lastAddress?.provincia || '',
            canton: crm.lastAddress?.canton || '',
            distrito: crm.lastAddress?.distrito || '',
            codigoPostal: crm.lastAddress?.codigoPostal || '',
            señas: crm.lastAddress?.señas || '',
            paymentPhone: crm.paymentPhone || '',
          }));
        }
      } catch (err) {
        console.error('Error loading CRM data:', err);
      }
    };
    loadCrmData();
  }, [user?.uid]);

  // Sin sesión todavía: se está creando la sesión de invitado (o falló)
  if (!user) {
    if (items.length === 0 && !authLoading) {
      // carrito vacío: se muestra el estado vacío más abajo
    } else if (guestError) {
      return (
        <div className="max-w-lg mx-auto px-4 py-20 text-center" role="alert">
          <ShoppingBag className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h2 className="text-xl font-black text-slate-900 mb-2">No pudimos iniciar el checkout</h2>
          <p className="text-sm text-slate-400 mb-6">{guestError}</p>
          <button onClick={() => { setGuestError(null); ensureGuestSession().catch(() => setGuestError('Seguimos sin conexión. Intentá de nuevo en unos minutos.')); }} className="px-6 py-3 bg-rose-600 text-white font-bold rounded-xl text-sm">Reintentar</button>
        </div>
      );
    } else {
      return <LoadingSpinner />;
    }
  }

  if (items.length === 0) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <ShoppingBag className="w-12 h-12 text-slate-300 mx-auto mb-4" />
        <h2 className="text-xl font-black text-slate-900 mb-2">Tu carrito está vacío</h2>
        <Link to="/catalogo" className="inline-flex items-center justify-center mt-4 px-6 py-3 bg-rose-600 hover:bg-rose-700 text-white text-sm font-bold rounded-2xl transition-all">Ver catálogo</Link>
      </div>
    );
  }

  const shippingCost = form.canton ? calculateShippingCost(form.canton, form.shippingType) : 0;
  const total = subtotal + shippingCost;
  // "Bajo pedido": se aparta con el 50% de esas líneas; stock y envío se pagan completos.
  // PayPal confirma estos mismos importes con su cotización calculada en servidor.
  const backorder = computeBackorder(items, shippingCost);
  const showDeposit = backorder.hasBackorder && backorder.depositTotal > 0;
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

  // Cada compra requiere una elección explícita, también para clientes recurrentes.
  const paymentMethods = listPaymentMethods(availability, { items });
  const selectedMethod = getPaymentMethod(selectedPaymentMethod);
  const OnlinePanel = isOnlineMethod(selectedPaymentMethod) && availability[selectedPaymentMethod]?.available ? selectedMethod.Panel : null;
  const paypalSelected = selectedPaymentMethod === 'paypal';
  const tilopaySelected = selectedPaymentMethod === 'tilopay';
  const serverQuoteSelected = paypalSelected || tilopaySelected;
  const cashOnDeliverySelected = selectedPaymentMethod === 'contra_entrega';
  const activePaypalQuote = paypalQuote?.key === paypalQuoteKey(items, form.canton, form.shippingType) ? paypalQuote.quote : null;
  const activeTilopayQuote = tilopayQuote?.uid === user?.uid
    && tilopayQuote?.key === tilopayQuoteKey(items, form.canton, form.shippingType) ? tilopayQuote.quote : null;
  const activeServerQuote = tilopaySelected ? activeTilopayQuote : activePaypalQuote;
  const paymentSummary = paypalSelected ? backorderFromPaypalQuote(activePaypalQuote)
    : tilopaySelected ? backorderFromTilopayQuote(activeTilopayQuote) : backorder;
  const showPaymentDeposit = paymentSummary?.hasBackorder && paymentSummary.depositTotal > 0
    && (!OnlinePanel || serverQuoteSelected);

  // Valida el formulario; devuelve true si todo está completo
  const validateForm = () => {
    const newErrors = {};
    if (!form.name.trim()) newErrors.name = 'Nombre requerido';
    if (cashOnDeliverySelected) {
      if (!isValidGiveawayPhone(form.phone)) newErrors.phone = GIVEAWAY_PHONE_ERROR;
    } else {
      if (!form.phone.trim()) newErrors.phone = 'Teléfono requerido';
      else if (form.phone.replace(/\D/g, '').length < 8) newErrors.phone = 'Teléfono inválido (mínimo 8 dígitos)';
    }
    if (!form.email.trim()) newErrors.email = 'Correo requerido';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) newErrors.email = 'Correo inválido';
    if (!form.provincia) newErrors.provincia = 'Selecciona provincia';
    if (!form.canton) newErrors.canton = 'Cantón requerido';
    if (!form.distrito) newErrors.distrito = 'Distrito requerido';
    if (!form.señas.trim()) newErrors.señas = 'Señas requeridas';
    if (form.customerNotes.length > 1000) newErrors.customerNotes = 'Las notas pueden tener hasta 1000 caracteres.';
    if (!selectedPaymentMethod || !paymentMethods.some(m => m.id === selectedPaymentMethod)) newErrors.paymentMethod = 'Selecciona método de pago';
    if (invalidCashOnDeliverySelection) {
      newErrors.paymentMethod = 'Contra entrega solo está disponible cuando todos los productos están en stock. Elegí otro método de pago.';
      setForm(prev => ({ ...prev, paymentMethod: '' }));
    }
    if (form.paymentMethod === 'sinpe' && !form.paymentPhone.trim()) {
      newErrors.paymentPhone = 'Teléfono de SINPE requerido';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const buildOrderData = (paymentMethod) => ({
    uid: user.uid,
    customerEmail: form.email.trim(),
    isGuest: !!user.isAnonymous,
    customerName: form.name,
    customerPhone: form.phone,
    customerCedula: form.cedula,
    customerNotes: form.customerNotes.trim(),
    paymentMethod,
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

  // Pasarelas online: crea (o reutiliza) el pedido pendiente justo antes de pagar
  const createPendingOrder = async (paymentMethod) => {
    const data = buildOrderData(paymentMethod);
    const key = JSON.stringify(data);
    if (pendingOrderRef.current?.key === key) return pendingOrderRef.current.promise;
    const pending = { key, customerNotes: data.customerNotes,
      promise: paymentMethod === 'paypal' ? createPaypalPendingOrder(data) : createOrder(data) };
    pendingOrderRef.current = pending;
    try {
      const result = await pending.promise;
      pending.orderId = result.orderId;
      return result;
    } catch (error) {
      if (pendingOrderRef.current === pending) pendingOrderRef.current = null;
      throw error;
    }
  };

  const handleOnlinePaid = ({ orderId, orderNumber, paypalResult, paypalQuote: confirmedQuote, partial }) => {
    clearCart();
    navigate(`/orden-confirmada/${orderId}`, {
      state: { orderNumber, total: confirmedQuote?.crcTotal ?? total, paymentMethod: form.paymentMethod,
        paid: paypalResult !== 'pending', online: true, paypalQuote: confirmedQuote, partial,
        customerNotes: pendingOrderRef.current?.orderId === orderId ? pendingOrderRef.current.customerNotes : undefined },
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Los métodos online pagan desde su propio panel
    if (OnlinePanel || submittingRef.current) return;
    if (!validateForm()) return;

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const data = buildOrderData(selectedPaymentMethod);
      const result = cashOnDeliverySelected
        ? await createCashOnDeliveryOrder(data) : await createOrder(data);

      clearCart();
      navigate(`/orden-confirmada/${result.orderId}`, { state: {
        orderNumber: result.orderNumber, total: cashOnDeliverySelected ? result.total : total, paymentMethod: selectedPaymentMethod,
        customerNotes: data.customerNotes,
        ...(cashOnDeliverySelected
          ? { paid: false, online: false, paymentStatus: 'pendiente', amountDueOnDelivery: result.amountDueOnDelivery }
          : { backorder: computeBackorder(items, shippingCost) }),
      } });
    } catch (err) {
      if (cashOnDeliverySelected) console.error('Error creating cash-on-delivery order:', err?.code || 'unknown');
      else console.error('Error creating order:', err);
      const cashValidationError = cashOnDeliverySelected && err?.code === 'functions/invalid-argument';
      const errorMessage = cashValidationError
        ? (CASH_VALIDATION_MESSAGES.has(err.message) ? err.message : 'Revisá tu nombre, teléfono, correo y dirección de entrega e intentá de nuevo.')
        : err?.code === 'functions/failed-precondition'
        ? err.message || 'Stock insuficiente para uno o más productos.'
        : err?.code === 'functions/unauthenticated'
          ? 'Tu sesión expiró. Por favor inicia sesión de nuevo.'
          : 'Error al crear el pedido. Intenta de nuevo.';
      setErrors({ submit: errorMessage,
        ...(cashValidationError && errorMessage === GIVEAWAY_PHONE_ERROR ? { phone: GIVEAWAY_PHONE_ERROR } : {}),
      });
      submittingRef.current = false;
      setSubmitting(false);
    }
  };


  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-8 pb-[calc(6rem+env(safe-area-inset-bottom,0px))] lg:pb-8">
      <Link to="/catalogo" className="inline-flex items-center gap-1 text-sm font-bold text-rose-600 hover:text-rose-700 mb-6">
        <ArrowLeft className="w-4 h-4" /> Seguir comprando
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
            {user?.isAnonymous && <SaveAccountPrompt compact />}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nombre completo</label>
                <input value={form.name} onChange={e => handleChange('name', e.target.value)} className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 ${errors.name ? 'border-red-300 bg-red-50' : 'border-slate-200'}`} />
                {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
              </div>
              <div>
                <label htmlFor="checkout-cedula" className="text-xs font-bold text-slate-400 uppercase mb-1 block">Cédula (opcional)</label>
                <input id="checkout-cedula" value={form.cedula} onChange={e => handleChange('cedula', e.target.value)} placeholder="0-0000-0000" className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 ${errors.cedula ? 'border-red-300 bg-red-50' : 'border-slate-200'}`} />
                {errors.cedula && <p className="text-xs text-red-500 mt-1">{errors.cedula}</p>}
              </div>
              <div>
                <label htmlFor="checkout-phone" className="text-xs font-bold text-slate-400 uppercase mb-1 block">Teléfono</label>
                <input id="checkout-phone" type="tel" autoComplete="tel" value={form.phone} onChange={e => handleChange('phone', e.target.value)} placeholder="8888-8888" aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? 'checkout-phone-error' : undefined} className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 ${errors.phone ? 'border-red-300 bg-red-50' : 'border-slate-200'}`} />
                {errors.phone && <p id="checkout-phone-error" role="alert" className="text-xs text-red-500 mt-1">{errors.phone}</p>}
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Email</label>
                <input value={form.email} type="email" autoComplete="email" placeholder="correo@ejemplo.com" onChange={e => handleChange('email', e.target.value)} className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 ${errors.email ? 'border-red-300 bg-red-50' : 'border-slate-200'}`} />
                {errors.email && <p className="text-xs text-red-500 mt-1">{errors.email}</p>}
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
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-900">{opt.label}</p>
                        <p className="text-xs text-slate-400">{opt.estimatedDays}</p>
                        {opt.description && <p className="text-xs text-slate-500 mt-1">{opt.description}</p>}
                      </div>
                    </div>
                    <span className="text-sm font-black text-emerald-600">{opt.price > 0 ? formatCRC(opt.price) : 'Envío incluido'}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-2">
            <label htmlFor="checkout-customer-notes" className="block font-black text-lg text-slate-900">Notas del pedido (opcional)</label>
            <p id="checkout-customer-notes-help" className="text-sm text-slate-500">Podés agregar indicaciones para preparar o entregar tu pedido.</p>
            <textarea
              id="checkout-customer-notes"
              value={form.customerNotes}
              onChange={e => handleChange('customerNotes', e.target.value)}
              maxLength={1000}
              rows={3}
              aria-invalid={Boolean(errors.customerNotes)}
              aria-describedby={`checkout-customer-notes-help checkout-customer-notes-count${errors.customerNotes ? ' checkout-customer-notes-error' : ''}`}
              placeholder="Ej.: llamar antes de entregar."
              className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 resize-y ${errors.customerNotes ? 'border-red-300 bg-red-50' : 'border-slate-200'}`}
            />
            <p id="checkout-customer-notes-count" className="text-xs text-slate-400 text-right">{form.customerNotes.length}/1000 caracteres</p>
            {errors.customerNotes && <p id="checkout-customer-notes-error" role="alert" className="text-xs text-red-500">{errors.customerNotes}</p>}
          </div>

          {/* Payment */}
          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-4">
            <h2 className="font-black text-lg text-slate-900">Método de Pago</h2>
            {!selectedPaymentMethod && <p className="text-sm text-slate-500">Elegí cómo querés pagar este pedido.</p>}
            {errors.paymentMethod && <p className="text-xs text-red-500">{errors.paymentMethod}</p>}
            {invalidCashOnDeliverySelection && <p role="alert" className="text-sm text-amber-800">La selección de contra entrega dejó de ser válida porque el carrito cambió. Elegí otro método de pago.</p>}
            {!cashOnDeliveryEligible && <p className="text-xs text-slate-500">Contra entrega solo está disponible para pedidos con todos sus productos en stock. Los productos Bajo pedido requieren el apartado del {BACKORDER_DEPOSIT_LABEL}.</p>}
            <div className="space-y-2">
              {paymentMethods.map(({ id: key, label, icon }) => {
                const Icon = icon || CreditCard;
                const selected = selectedPaymentMethod === key;
                return (
                  <label key={key} className={`relative flex items-center gap-3 p-4 rounded-xl border cursor-pointer transition-all ${selected ? 'border-rose-400 bg-rose-50' : 'border-slate-200 hover:border-rose-200'}`}>
                    <input type="radio" name="payment" value={key} checked={selected} onChange={() => handleChange('paymentMethod', key)} className="accent-rose-600" />
                    <Icon className="w-5 h-5 text-slate-500" />
                    <span className="text-sm font-bold text-slate-900">{label}</span>
                  </label>
                );
              })}
            </div>
            {cashOnDeliverySelected && (
              <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50" data-testid="cash-on-delivery-instructions">
                <p className="text-sm font-bold text-emerald-900">Pagás el total en efectivo al recibir tu pedido.</p>
                <p className="text-sm text-emerald-900 mt-1">No necesitás adelanto ni comprobante de pago. Revisaremos el stock y el monto al confirmar el pedido.</p>
              </div>
            )}
            {paypalSelected && paymentMethods.some(m => m.id === 'paypal') && (
              <div className="flex gap-3 p-4 rounded-xl border-2 border-emerald-300 bg-emerald-50" data-testid="paypal-trust-note">
                <ShieldCheck className="w-6 h-6 text-emerald-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-black text-emerald-900">Pagá con PayPal y comprás protegido</p>
                  <p className="text-sm text-emerald-900 mt-0.5">Si tu pedido no te llega o no es como lo describimos, podés abrir una reclamación con la Protección al Comprador de PayPal y, si cumplís sus requisitos, recuperar tu dinero.</p>
                  <p className="text-[11px] text-emerald-800 mt-1">Aplican las condiciones de PayPal (plazos y requisitos). <a href="https://www.paypal.com/cr/legalhub/paypal/buyer-protection" target="_blank" rel="noopener noreferrer" className="underline font-bold">Ver Protección al Comprador</a></p>
                </div>
              </div>
            )}
            {form.paymentMethod === 'sinpe' && (
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Teléfono SINPE (el mismo con que pagarás)</label>
                <input value={form.paymentPhone} onChange={e => handleChange('paymentPhone', e.target.value)} placeholder="8888-8888" className={`w-full px-4 py-3 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500 ${errors.paymentPhone ? 'border-red-300' : 'border-slate-200'}`} />
                <div className="mt-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                  <p className="text-sm font-bold text-blue-900">Pagá por SINPE Móvil al <span className="text-lg font-black whitespace-nowrap">{SINPE_INFO.number}</span></p>
                  {SINPE_INFO.holder && <p className="text-sm text-blue-900">A nombre de {SINPE_INFO.holder}</p>}
                  <p className="text-sm text-blue-800 mt-1">Al confirmar el pedido te mostramos el monto exacto y el número de pedido para poner en la descripción del SINPE.</p>
                </div>
              </div>
            )}
            {form.paymentMethod === 'transferencia' && (
              <div className="p-4 bg-blue-50 rounded-xl border border-blue-200 space-y-2">
                <p className="text-xs font-bold text-blue-700">Datos para transferencia:</p>
                <div className="space-y-1">
                  <p className="text-sm text-blue-900"><span className="font-bold">IBAN:</span> CR15081400011020004961</p>
                  <p className="text-sm text-blue-900"><span className="font-bold">SINPE Móvil:</span> {SINPE_INFO.number}</p>
                </div>
                <p className="text-[10px] text-blue-500">Subí tu comprobante después de realizar el pago</p>
              </div>
            )}
            {OnlinePanel && (
              <OnlinePanel
                items={items}
                canton={form.canton}
                shippingType={form.shippingType}
                totalCRC={total}
                validateForm={validateForm}
                createPendingOrder={createPendingOrder}
                onPaid={handleOnlinePaid}
                onQuote={tilopaySelected ? setTilopayQuote : setPaypalQuote}
              />
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
                <span className="font-bold">{tilopaySelected && !paymentSummary ? 'Calculando…'
                  : formatCRC(serverQuoteSelected && activeServerQuote ? activeServerQuote.crcSubtotal : subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Envío</span>
                <span className="font-bold">{tilopaySelected && !paymentSummary ? 'Calculando…'
                  : (serverQuoteSelected && activeServerQuote ? activeServerQuote.crcShipping : shippingCost) > 0
                    ? formatCRC(serverQuoteSelected && activeServerQuote ? activeServerQuote.crcShipping : shippingCost) : 'Incluido'}</span>
              </div>
              <div className="flex justify-between text-lg pt-2 border-t border-slate-100">
                <span className="font-black text-slate-900">Total</span>
                <span className="font-black text-rose-600">{tilopaySelected && !paymentSummary ? 'Calculando…'
                  : formatCRC(serverQuoteSelected && activeServerQuote ? activeServerQuote.crcTotal : total)}</span>
              </div>
              {serverQuoteSelected && !paymentSummary && (
                <p className="text-xs text-sky-800">El servidor confirmará el monto a pagar ahora y el saldo antes de habilitar {tilopaySelected ? 'el pago con tarjeta' : 'PayPal'}.</p>
              )}
              {cashOnDeliverySelected && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-1.5" data-testid="cash-on-delivery-summary">
                  <p className="text-sm font-bold text-emerald-900">Pagás ahora {formatCRC(0)}</p>
                  <p className="text-sm font-black text-emerald-900">Pagás al recibir {formatCRC(total)}</p>
                  <p className="text-xs text-emerald-800">En efectivo, por el total del pedido.</p>
                </div>
              )}
              {serverQuoteSelected && paymentSummary && !showPaymentDeposit && (
                <p className="text-sm font-black text-sky-900">Pagás ahora {formatCRC(paymentSummary.payNowTotal)}</p>
              )}
              {showPaymentDeposit && (
                <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-3 space-y-1.5" data-testid="deposit-summary">
                  <p className="text-sm font-black text-amber-900">Tu pedido incluye productos «Bajo pedido»</p>
                  <div className="flex justify-between text-sm">
                    {serverQuoteSelected
                      ? <span className="font-black text-amber-900">Pagás ahora {formatCRC(paymentSummary.payNowTotal)} (apartado {BACKORDER_DEPOSIT_LABEL})</span>
                      : <><span className="font-bold text-amber-900">Apartás hoy con ({BACKORDER_DEPOSIT_LABEL} de esos productos)</span>
                        <span className="font-black text-amber-900">{formatCRC(paymentSummary.payNowTotal)}</span></>}
                  </div>
                  <p className="text-[11px] text-amber-800">Incluye los productos en stock y el envío completos, más el {BACKORDER_DEPOSIT_LABEL} de los productos bajo pedido ({formatCRC(paymentSummary.depositTotal)}).</p>
                  <div className="flex justify-between text-sm text-amber-900">
                    <span>Total del pedido</span><span className="font-bold">{formatCRC(paymentSummary.total)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-amber-900">
                    <span>Saldo restante</span><span className="font-bold">{formatCRC(paymentSummary.balanceDue)}</span>
                  </div>
                  <p className="text-xs text-amber-800">El saldo se paga {BACKORDER_BALANCE_TIMING}.</p>
                </div>
              )}
            </div>
            <p className="text-[10px] text-slate-400 text-center">
              Al comprar aceptas los <Link to="/terminos" className="underline">términos</Link>, las <Link to="/devoluciones" className="underline">devoluciones</Link> y los <Link to="/envios" className="underline">envíos</Link>.
            </p>
            {OnlinePanel ? (
              <p className="text-[11px] text-slate-400 text-center">Paga con el panel de pago de arriba para confirmar tu pedido.</p>
            ) : (
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-4 bg-rose-600 hover:bg-rose-700 text-white font-black rounded-2xl transition-all shadow-lg active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              {submitting ? 'Procesando...' : cashOnDeliverySelected ? 'Confirmar pedido contra entrega'
                : (showDeposit ? `Apartá con ${formatCRC(backorder.payNowTotal)} (${BACKORDER_DEPOSIT_LABEL})` : `Confirmar Pedido · ${formatCRC(total)}`)}
            </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
