import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';
import { normalizeCustomerNotes } from '../../../functions/lib/customerNotes.mjs';

const call = (name) => async (data) => (await httpsCallable(functions, name)(data)).data;

export const paypalGetConfig = call('paypalGetConfig');
export const paypalGetQuote = call('paypalGetQuote');
export const paypalCreateOrder = call('paypalCreateOrder');
export const paypalCaptureOrder = call('paypalCaptureOrder');

// PayPal starts with a canonical order and an atomic inventory reservation.
// No price, supply type or financial state from the cart is sent as authority.
export const createPaypalPendingOrder = (order) => call('createOrderWithReservation')({
  paymentMethod: 'paypal',
  customerName: order.customerName,
  customerEmail: order.customerEmail,
  customerPhone: order.customerPhone,
  customerNotes: normalizeCustomerNotes(order.customerNotes),
  shippingAddress: order.shippingAddress,
  shippingType: order.shippingType,
  items: order.items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
});

let sdkPromise = null;

/** Carga el JS SDK de PayPal (una sola vez) con moneda USD. */
export function loadPaypalSdk(clientId) {
  if (window.paypal?.Buttons) return Promise.resolve(window.paypal);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons&locale=es_CR`;
    s.async = true;
    s.onload = () => (window.paypal?.Buttons ? resolve(window.paypal) : reject(new Error('PayPal SDK no disponible')));
    s.onerror = () => { sdkPromise = null; reject(new Error('No se pudo cargar PayPal')); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}
