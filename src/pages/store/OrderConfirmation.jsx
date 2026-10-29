import { useEffect, useState } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { formatCRC } from '../../utils/formatters';
import { SINPE_INFO } from '../../utils/constants';
import { computeBackorder, BACKORDER_DEPOSIT_PERCENT, BACKORDER_DEPOSIT_LABEL, BACKORDER_BALANCE_TIMING } from '../../utils/backorder';
import CopyButton from '../../components/ui/CopyButton';
import { CheckCircle, ArrowRight } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import SaveAccountPrompt from '../../components/auth/SaveAccountPrompt';
import { backorderFromPaypalQuote } from '../../services/payments/paypalQuote';

// Número de WhatsApp Business de Aquí Pauli (formato internacional sin +)
const WHATSAPP_NUMBER = '50671613342';

// Un cambio de política no modifica el apartado ya guardado de un pedido.
// Ambos creadores existentes lo persisten: cliente en backorderDeposit,
// callable en depositTotal/backorderDeposit. No se escribe ni migra el pedido.
function savedBackorder(order) {
  if (!order) return null;
  const summary = computeBackorder(order.itemsSummary || [], order.shippingCost);
  const deposit = order.backorderDeposit ?? order.depositTotal;
  if (!summary.hasBackorder || typeof deposit !== 'number' || !Number.isFinite(deposit)
      || deposit < 0 || deposit > summary.backorderSubtotal) return summary;
  const balanceDue = summary.backorderSubtotal - deposit;
  return { ...summary, depositTotal: deposit, balanceDue, payNowTotal: summary.total - balanceDue };
}

function depositLabelFor(backorder) {
  if (!backorder?.hasBackorder || !(backorder.backorderSubtotal > 0)) return null;
  if (backorder.depositTotal === Math.round(backorder.backorderSubtotal * BACKORDER_DEPOSIT_PERCENT)) {
    return BACKORDER_DEPOSIT_LABEL;
  }
  // Pedidos creados con la política anterior conservan su importe y su texto.
  if (backorder.depositTotal === Math.round(backorder.backorderSubtotal * 0.25)) return '25%';
  return null;
}

export default function OrderConfirmation() {
  const { orderId } = useParams();
  const { user, loading: authLoading } = useAuth();
  const isGuest = !authLoading && !!user?.isAnonymous;
  const hasAccount = !authLoading && !!user && !user.isAnonymous;
  const location = useLocation();
  // Datos del pedido: primero lo que manda el checkout; si se recarga la página, se leen del pedido guardado.
  const [savedOrder, setSavedOrder] = useState(null);
  useEffect(() => {
    if (!user || !orderId) return undefined;
    let cancelled = false;
    getDoc(doc(db, 'orders', orderId))
      .then(snap => { if (!cancelled && snap.exists()) setSavedOrder(snap.data()); })
      .catch(() => { /* sin acceso: se usa lo que vino del checkout */ });
    return () => { cancelled = true; };
  }, [user, orderId]);

  const orderNumber = savedOrder?.orderNumber || location.state?.orderNumber || orderId;
  const total = savedOrder?.total ?? location.state?.total ?? '';
  const paymentMethod = savedOrder?.paymentMethod || location.state?.paymentMethod || '';
  const isSinpe = paymentMethod === 'sinpe' || paymentMethod === 'sinpe_movil';
  const isPaypal = paymentMethod === 'paypal';
  const totalNum = Number(total) || 0;
  // Nuevos pedidos: 50% solo de Bajo pedido. Al cargar, prima el apartado guardado.
  const paypalQuote = savedOrder?.paypal || location.state?.paypalQuote;
  const backorder = (isPaypal && backorderFromPaypalQuote(paypalQuote))
    || savedBackorder(savedOrder) || location.state?.backorder || null;
  const depositLabel = depositLabelFor(backorder);
  const fullyPaid = savedOrder && ['pagado', 'verificado'].includes(savedOrder.paymentStatus);
  const hasDeposit = !!backorder?.hasBackorder && backorder.depositTotal > 0 && backorder.payNowTotal < backorder.total
    && !(isPaypal && fullyPaid);
  const amountToPay = hasDeposit ? backorder.payNowTotal : totalNum;

  const paid = savedOrder ? !!fullyPaid || (isPaypal && savedOrder.paymentStatus === 'parcial') : !!location.state?.paid;
  const online = savedOrder ? ['paypal', 'tilopay'].includes(paymentMethod) : !!location.state?.online;
  const paypalReceived = paid && typeof savedOrder?.paymentAmount === 'number' ? savedOrder.paymentAmount : amountToPay;
  const paypalRemaining = fullyPaid ? 0 : (typeof savedOrder?.remainingTotal === 'number'
    ? savedOrder.remainingTotal : backorder?.balanceDue || 0);

  const needsProof = isSinpe || paymentMethod === 'transferencia';

  // Mensaje pre-llenado para WhatsApp
  const waMessage = encodeURIComponent(
    `¡Hola! 👋 Mi pedido es *${orderNumber}*${amountToPay ? `. Pagué *${formatCRC(amountToPay)}*${hasDeposit ? (depositLabel ? ` (apartado, ${depositLabel} de los productos bajo pedido)` : ' (apartado acordado)') : ''} por SINPE Móvil` : ''}.\n\nAdjunto mi comprobante de pago 📎`
  );
  const waLink = `https://wa.me/${WHATSAPP_NUMBER}?text=${waMessage}`;

  return (
    <div className="max-w-lg mx-auto px-4 py-20 text-center">
      <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
        <CheckCircle className="w-10 h-10 text-green-600" />
      </div>
      <h1 className="text-2xl font-black text-slate-900 mb-2">
        ¡Tu pedido <span className="whitespace-nowrap">{orderNumber}</span> quedó registrado!
      </h1>
      <p className="text-sm text-slate-500 mb-6">
        Guardá este número para cualquier consulta sobre tu compra.
      </p>
      {online && (
        <p className={`text-sm font-bold mb-6 ${paid ? 'text-green-700' : 'text-amber-700'}`}>
          {paid ? (isPaypal && hasDeposit ? '✅ Apartado recibido con PayPal.' : `✅ Pago recibido con ${paymentMethod === 'tilopay' ? 'tarjeta' : 'PayPal'}.`)
            : `Tu pago con ${paymentMethod === 'tilopay' ? 'tarjeta' : 'PayPal'} está en revisión; te avisaremos por WhatsApp.`}
        </p>
      )}

      {isGuest && <div className="mb-6 text-left"><SaveAccountPrompt /></div>}

      {isPaypal && (savedOrder || paypalQuote) && (
        <div className="bg-sky-50 border-2 border-sky-200 rounded-2xl p-5 text-left mb-6 space-y-2" data-testid="paypal-confirmation">
          <h2 className="text-base font-black text-sky-900">{hasDeposit ? 'Tu apartado con PayPal' : 'Tu pago con PayPal'}</h2>
          <p className="text-sm text-sky-900">{paid ? 'Monto recibido' : 'Monto del pago en revisión'}: <strong>{formatCRC(paypalReceived)}</strong>
            {hasDeposit ? ` (apartado ${depositLabel || 'acordado'})` : ''}</p>
          <p className="text-sm text-sky-900">Total del pedido: <strong>{formatCRC(totalNum || backorder?.total || 0)}</strong></p>
          <p className="text-sm text-sky-900">Saldo pendiente: <strong>{formatCRC(paypalRemaining)}</strong></p>
          {hasDeposit && <>
            <p className="text-sm text-sky-900">El pago incluye los productos en stock y el envío completos, más {depositLabel ? `el ${depositLabel} de los productos Bajo pedido` : 'el apartado acordado'}.</p>
            <p className="text-sm text-sky-900">El saldo se paga {BACKORDER_BALANCE_TIMING}.</p>
          </>}
        </div>
      )}

      {isSinpe && (
        <div className="bg-blue-50 border-2 border-blue-300 rounded-2xl p-5 text-left mb-6" data-testid="sinpe-instructions">
          <h2 className="text-base font-black text-blue-900 mb-1">Cómo pagar por SINPE Móvil</h2>
          <p className="text-sm text-blue-900 mb-4">Hacé el SINPE con estos datos y poné el número de pedido en la descripción.</p>
          <div className="space-y-3">
            {amountToPay > 0 && (
              <div>
                <p className="text-xs font-bold text-blue-800 uppercase">{hasDeposit ? 'Monto a pagar ahora (apartado)' : 'Monto a pagar'}</p>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-2xl font-black text-slate-900">{formatCRC(amountToPay)}</span>
                  <CopyButton text={amountToPay} label="Copiar" ariaLabel="Copiar monto" />
                </div>
                {hasDeposit && (
                  <div className="text-sm text-blue-900 mt-2 space-y-1" data-testid="deposit-detail">
                    <p>Tu pedido incluye productos «Bajo pedido». Pagás hoy los productos en stock y el envío completos, más {depositLabel ? `el ${depositLabel} de los productos bajo pedido` : 'el apartado acordado para los productos bajo pedido'} ({formatCRC(backorder.depositTotal)}).</p>
                    <p>Total del pedido: <strong>{formatCRC(backorder.total)}</strong> · Saldo restante: <strong>{formatCRC(backorder.balanceDue)}</strong></p>
                    <p>El saldo se paga {BACKORDER_BALANCE_TIMING}.</p>
                  </div>
                )}
              </div>
            )}
            <div>
              <p className="text-xs font-bold text-blue-800 uppercase">Número SINPE Móvil</p>
              <div className="flex items-center justify-between gap-3">
                <span className="text-2xl font-black text-slate-900 whitespace-nowrap">{SINPE_INFO.number}</span>
                <CopyButton text={SINPE_INFO.number.replace(/\D/g, '')} label="Copiar" ariaLabel="Copiar número SINPE" />
              </div>
              {SINPE_INFO.holder && <p className="text-sm text-blue-900">A nombre de <strong>{SINPE_INFO.holder}</strong></p>}
            </div>
            <div>
              <p className="text-xs font-bold text-blue-800 uppercase">Descripción del SINPE (número de pedido)</p>
              <div className="flex items-center justify-between gap-3">
                <span className="text-2xl font-black text-slate-900 whitespace-nowrap">{orderNumber}</span>
                <CopyButton text={orderNumber} label="Copiar" ariaLabel="Copiar número de pedido" />
              </div>
            </div>
          </div>
          <p className="text-sm text-blue-900 mt-4">Después de pagar, enviá el comprobante por WhatsApp con el botón verde.</p>
        </div>
      )}

      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-left mb-6">
        <h3 className="text-sm font-bold text-amber-800 mb-2">Próximos pasos:</h3>
        <ul className="text-sm text-amber-800 space-y-1.5">
          {!online && (isSinpe
            ? <li>• Hacé el SINPE con los datos de arriba, con tu número de pedido en la descripción</li>
            : <li>• Realiza el pago con el método seleccionado</li>)}
          {needsProof && <li>• <strong>Envía tu comprobante por WhatsApp</strong> con el botón verde</li>}
          <li>• Recibirás actualizaciones por WhatsApp</li>
          {hasAccount && <li>• Podrás ver tu pedido en «Mis Pedidos»</li>}
        </ul>
      </div>

      {/* Botón WhatsApp para enviar comprobante */}
      {needsProof && (
        <a
          href={waLink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-3 w-full py-4 bg-[#25D366] hover:bg-[#1ebe57] text-white font-black rounded-2xl transition-all shadow-lg active:scale-95 text-sm mb-4"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
          </svg>
          Enviar Comprobante por WhatsApp
        </a>
      )}

      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link
          to="/catalogo"
          className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-rose-600 text-white font-bold rounded-xl text-sm shadow-lg active:scale-95 transition-all"
        >
          Seguir Comprando <ArrowRight className="w-4 h-4" />
        </Link>
        {hasAccount && (
          <Link
            to="/mi-cuenta"
            className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-white border border-slate-200 text-slate-700 font-bold rounded-xl text-sm shadow-sm hover:bg-slate-50 transition-all"
          >
            Ver Mis Pedidos
          </Link>
        )}
      </div>
    </div>
  );
}
