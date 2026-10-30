import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';
import { normalizeCustomerNotes } from '../../../functions/lib/customerNotes.mjs';
import { GIVEAWAY_PHONE_ERROR, isValidGiveawayPhone, normalizeGiveawayPhone } from '../../../functions/lib/giveawayPhone.mjs';

// Los precios, el dueño, el stock y el estado financiero los fija el servidor.
// Contra entrega nunca utiliza la escritura directa de pedidos del navegador.
export async function createCashOnDeliveryOrder(order) {
  // Validar el texto original y normalizarlo una sola vez evita aceptar dos
  // prefijos de país consecutivos o recortar silenciosamente números largos.
  if (!isValidGiveawayPhone(order.customerPhone)) {
    throw Object.assign(new Error(GIVEAWAY_PHONE_ERROR), { code: 'functions/invalid-argument' });
  }
  const payload = {
    paymentMethod: 'contra_entrega',
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: normalizeGiveawayPhone(order.customerPhone),
    customerCedula: order.customerCedula || '',
    customerNotes: normalizeCustomerNotes(order.customerNotes),
    shippingAddress: order.shippingAddress,
    shippingType: order.shippingType,
    items: order.items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
  };
  const { data } = await httpsCallable(functions, 'createOrderWithReservation')(payload);
  return data;
}
