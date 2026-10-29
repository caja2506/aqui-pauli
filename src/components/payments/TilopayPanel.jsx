import { useState } from 'react';
import { formatCRC } from '../../utils/formatters';
import { tilopayCreatePayment } from '../../services/payments/tilopayClient';

/**
 * Panel de Tilopay para el checkout. El cobro es en COLONES. El monto real lo
 * calcula el servidor (tilopayCreatePayment); aquí solo se muestra el total.
 * Al pagar, se redirige a la página de pago de Tilopay y vuelve a
 * /tilopay/retorno/:orderId, donde se confirma el pago contra la API.
 */
export default function TilopayPanel({ totalCRC, validateForm, createPendingOrder, canton }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const pay = async () => {
    setMessage('');
    if (!validateForm()) {
      setMessage('Completa los datos de contacto y envío antes de pagar.');
      return;
    }
    setBusy(true);
    try {
      const pending = await createPendingOrder('tilopay');
      const res = await tilopayCreatePayment({ orderId: pending.orderId });
      try {
        sessionStorage.setItem('aqp_tilopay_pending', JSON.stringify({ orderId: pending.orderId, orderNumber: pending.orderNumber, total: res.crcTotal }));
      } catch { /* sin sessionStorage: la página de retorno funciona igual */ }
      window.location.assign(res.url);
    } catch (e) {
      console.error('Tilopay error:', e);
      setMessage(e?.message || 'No se pudo iniciar el pago con tarjeta. Intenta de nuevo o elige otro método.');
      setBusy(false);
    }
  };

  return (
    <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-200 space-y-3">
      <p className="text-xs font-bold text-emerald-800">Pago con tarjeta (cobro en colones, sin conversión)</p>
      <p className="text-sm text-slate-800">
        Total a pagar: <span className="font-black">{formatCRC(totalCRC)}</span>
        {!canton && <span className="block text-[11px] text-slate-500">Selecciona tu cantón para ver el total final.</span>}
      </p>
      <p className="text-[11px] text-slate-500">
        Te llevaremos a la página segura de Tilopay para ingresar tu tarjeta. Aquí Pauli no ve ni guarda los datos de tu tarjeta.
      </p>
      <button
        type="button"
        onClick={pay}
        disabled={busy}
        className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? 'Redirigiendo…' : `Pagar ${formatCRC(totalCRC)} con tarjeta`}
      </button>
      {message && <p className="text-xs font-bold text-red-600">{message}</p>}
    </div>
  );
}
