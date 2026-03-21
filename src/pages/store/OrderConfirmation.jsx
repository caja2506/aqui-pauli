import React from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { CheckCircle, ArrowRight } from 'lucide-react';

export default function OrderConfirmation() {
  const { orderId } = useParams();
  const location = useLocation();
  const orderNumber = location.state?.orderNumber || orderId;

  return (
    <div className="max-w-lg mx-auto px-4 py-20 text-center">
      <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
        <CheckCircle className="w-10 h-10 text-green-600" />
      </div>
      <h1 className="text-2xl font-black text-slate-900 mb-2">¡Pedido Confirmado!</h1>
      <p className="text-sm text-slate-500 mb-6">
        Tu pedido <span className="font-bold text-slate-700">{orderNumber}</span> ha sido registrado exitosamente.
      </p>

      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-left mb-8">
        <h3 className="text-sm font-bold text-amber-800 mb-2">Próximos pasos:</h3>
        <ul className="text-xs text-amber-700 space-y-1.5">
          <li>• Realiza el pago con el método seleccionado</li>
          <li>• Si elegiste SINPE o transferencia, sube el comprobante</li>
          <li>• Recibirás actualizaciones por WhatsApp</li>
          <li>• Podrás rastrear tu pedido desde tu cuenta</li>
        </ul>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link
          to="/catalogo"
          className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-indigo-600 text-white font-bold rounded-xl text-sm shadow-lg active:scale-95 transition-all"
        >
          Seguir Comprando <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </div>
  );
}
