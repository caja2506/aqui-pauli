import { collection, doc, updateDoc, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../firebase';
import { normalizeCustomerNotes } from '../../functions/lib/customerNotes.mjs';

export async function createOrder(order) {
  const { data } = await httpsCallable(functions, 'createOrderWithReservation')({
    includeTotals: true, paymentMethod: order.paymentMethod, paymentPhone: order.paymentPhone || '',
    customerName: order.customerName, customerEmail: order.customerEmail, customerPhone: order.customerPhone,
    customerCedula: order.customerCedula || '', customerNotes: normalizeCustomerNotes(order.customerNotes),
    shippingAddress: order.shippingAddress, shippingType: order.shippingType,
    ...(order.expectedTotal !== undefined && { expectedTotal: order.expectedTotal }),
    ...(order.giftSample && { giftSample: order.giftSample }),
    ...(order.discountCode && { discountCode: order.discountCode, expectedDiscountAmount: order.expectedDiscountAmount,
      promotionRequestId: order.promotionRequestId }),
    items: order.items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
  });
  return data;
}

/**
 * Obtener items de una orden
 */
export async function getOrderItems(orderId) {
  const itemsSnap = await getDocs(collection(db, 'orders', orderId, 'items'));
  return itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Actualiza el estado de un pedido (solo admins)
 */
export async function updateOrderStatus(orderId, newStatus, notes = '') {
  const updates = {
    status: newStatus,
    updatedAt: new Date().toISOString(),
  };
  if (notes) updates.notes = notes;

  await updateDoc(doc(db, 'orders', orderId), updates);
}

/**
 * Actualiza el estado de pago
 */
export async function updatePaymentStatus(orderId, paymentData) {
  await updateDoc(doc(db, 'orders', orderId), {
    paymentStatus: paymentData.status,
    paymentProofUrl: paymentData.proofUrl || '',
    paymentPhone: paymentData.phone || '',
    paymentTransactionId: paymentData.transactionId || '',
    paymentAmount: paymentData.amount || 0,
    paymentDate: paymentData.date || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Agrega información de tracking
 */
export async function updateTracking(orderId, trackingNumber, trackingUrl) {
  await updateDoc(doc(db, 'orders', orderId), {
    trackingNumber,
    trackingUrl,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Sube comprobante de pago (URL)
 */
export async function uploadPaymentProof(orderId, proofUrl, paymentPhone = '') {
  await updateDoc(doc(db, 'orders', orderId), {
    paymentProofUrl: proofUrl,
    paymentPhone,
    paymentStatus: 'verificando',
    updatedAt: new Date().toISOString(),
  });
}
