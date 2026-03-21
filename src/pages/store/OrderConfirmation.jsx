import { useParams, useLocation, Link } from 'react-router-dom';
import { CheckCircle, ArrowRight } from 'lucide-react';

// Número de WhatsApp Business de Aquí Pauli (formato internacional sin +)
const WHATSAPP_NUMBER = '50670956070';

export default function OrderConfirmation() {
  const { orderId } = useParams();
  const location = useLocation();
  const orderNumber = location.state?.orderNumber || orderId;
  const total = location.state?.total || '';
  const paymentMethod = location.state?.paymentMethod || '';

  const needsProof = paymentMethod === 'sinpe' || paymentMethod === 'transferencia';

  // Mensaje pre-llenado para WhatsApp
  const waMessage = encodeURIComponent(
    `¡Hola! 👋 Acabo de hacer mi pedido *${orderNumber}*${total ? ` por *₡${Number(total).toLocaleString('es-CR')}*` : ''}.\n\nAdjunto mi comprobante de pago 📎`
  );
  const waLink = `https://wa.me/${WHATSAPP_NUMBER}?text=${waMessage}`;

  return (
    <div className="max-w-lg mx-auto px-4 py-20 text-center">
      <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
        <CheckCircle className="w-10 h-10 text-green-600" />
      </div>
      <h1 className="text-2xl font-black text-slate-900 mb-2">¡Pedido Confirmado!</h1>
      <p className="text-sm text-slate-500 mb-6">
        Tu pedido <span className="font-bold text-slate-700">{orderNumber}</span> ha sido registrado exitosamente.
      </p>

      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-left mb-6">
        <h3 className="text-sm font-bold text-amber-800 mb-2">Próximos pasos:</h3>
        <ul className="text-xs text-amber-700 space-y-1.5">
          <li>• Realiza el pago con el método seleccionado</li>
          {needsProof && <li>• <strong>Envía tu comprobante por WhatsApp</strong> con el botón verde</li>}
          <li>• Recibirás actualizaciones por WhatsApp</li>
          <li>• Podrás rastrear tu pedido desde tu cuenta</li>
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
        <Link
          to="/mi-cuenta"
          className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-white border border-slate-200 text-slate-700 font-bold rounded-xl text-sm shadow-sm hover:bg-slate-50 transition-all"
        >
          Ver Mis Pedidos
        </Link>
      </div>
    </div>
  );
}
