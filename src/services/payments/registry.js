// ==============================================
// Registro de métodos de pago del checkout.
//
// kind: 'manual'  → el cliente crea el pedido con el botón "Confirmar Pedido"
//                    y paga fuera de la web (SINPE, transferencia o efectivo al recibir).
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
import { Smartphone, Building, Banknote } from 'lucide-react';
import { paypalProvider } from './paypalProvider';
import { tilopayProvider } from './tilopayProvider';

export const MANUAL_METHODS = {
  sinpe: { id: 'sinpe', kind: 'manual', label: 'SINPE Móvil', icon: Smartphone },
  transferencia: { id: 'transferencia', kind: 'manual', label: 'Transferencia Bancaria', icon: Building },
  contra_entrega: { id: 'contra_entrega', kind: 'manual', label: 'Contra entrega (efectivo)', icon: Banknote, stockOnly: true },
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

// Esta comprobación controla la presentación; el servidor vuelve a consultar
// abastecimiento y disponibilidad en el catálogo antes de reservar el pedido.
export function isCashOnDeliveryEligible(items) {
  return Array.isArray(items) && items.length > 0
    && items.every((item) => item?.supplyType === 'stock_propio');
}

/** Métodos según disponibilidad online y composición actual del carrito. */
export function listPaymentMethods(availability = {}, { items = [] } = {}) {
  const manual = Object.values(MANUAL_METHODS)
    .filter((method) => !method.stockOnly || isCashOnDeliveryEligible(items));
  const online = Object.values(ONLINE_PROVIDERS).filter((p) => availability[p.id]?.available);
  return [...manual, ...online];
}

