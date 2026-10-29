// ==============================================
// Registro de métodos de pago del checkout.
//
// kind: 'manual'  → el cliente crea el pedido con el botón "Confirmar Pedido"
//                    y paga fuera de la web (SINPE, transferencia).
//       'online'  → el método trae su propio panel (Panel) con sus botones y
//                    se encarga de pagar; el pedido se crea al iniciar el pago.
//
// Un método 'online' implementa:
//   id, label, icon
//   getAvailability(): Promise<{ available: boolean, ...info }>
//   Panel: componente React con props:
//     { items, canton, shippingType, totalCRC, validateForm(),
//       createPendingOrder(methodId) → Promise<{orderId, orderNumber}>,
//       onPaid({ orderId, orderNumber }) }
//
// Tilopay (tarjeta, colones) ya está registrado pero apagado por config; ver docs/payments-tilopay.md.
// ==============================================
import { Smartphone, Building } from 'lucide-react';
import { paypalProvider } from './paypalProvider';
import { tilopayProvider } from './tilopayProvider';

export const MANUAL_METHODS = {
  sinpe: { id: 'sinpe', kind: 'manual', label: 'SINPE Móvil', icon: Smartphone },
  transferencia: { id: 'transferencia', kind: 'manual', label: 'Transferencia Bancaria', icon: Building },
};

export const ONLINE_PROVIDERS = {
  paypal: paypalProvider,
  tilopay: tilopayProvider, // apagado hasta config/payments.tilopay.enabled === true
};

export function getPaymentMethod(id) {
  return MANUAL_METHODS[id] || ONLINE_PROVIDERS[id] || null;
}

export function isOnlineMethod(id) {
  return !!ONLINE_PROVIDERS[id];
}

/** Métodos que se muestran en el checkout, según disponibilidad de los online. */
export function listPaymentMethods(availability = {}) {
  const online = Object.values(ONLINE_PROVIDERS).filter((p) => availability[p.id]?.available);
  return [...Object.values(MANUAL_METHODS), ...online];
}

