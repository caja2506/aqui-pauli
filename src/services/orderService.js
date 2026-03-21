import { collection, doc, setDoc, updateDoc, getDocs, writeBatch, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { generateOrderNumber } from '../utils/formatters';
import { ORDER_STATUS, BACKORDER_DEPOSIT_PERCENT } from '../utils/constants';

/**
 * Crea un pedido nuevo
 */
export async function createOrder(orderData) {
  const orderId = doc(collection(db, 'orders')).id;
  const orderNumber = generateOrderNumber();

  const order = {
    orderNumber,
    customerUid: orderData.customerUid,
    customerEmail: orderData.customerEmail,
    customerName: orderData.customerName,
    customerPhone: orderData.customerPhone,
    status: ORDER_STATUS.PENDIENTE_PAGO,
    paymentStatus: 'pendiente',
    paymentMethod: orderData.paymentMethod,
    paymentProofUrl: '',
    paymentPhone: orderData.paymentPhone || '',
    paymentTransactionId: '',
    paymentAmount: 0,
    paymentDate: '',
    subtotal: orderData.subtotal,
    shippingCost: orderData.shippingCost,
    total: orderData.subtotal + orderData.shippingCost,
    shippingType: orderData.shippingType || 'normal',
    shippingAddress: orderData.shippingAddress,
    trackingNumber: '',
    trackingUrl: '',
    hasBackorderItems: orderData.items.some(i => i.supplyType === 'bajo_pedido'),
    backorderDepositPaid: false,
    backorderRemainingPaid: false,
    notes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const batch = writeBatch(db);

  // Crear orden principal
  batch.set(doc(db, 'orders', orderId), order);

  // Crear sub-items
  for (const item of orderData.items) {
    const itemRef = doc(collection(db, 'orders', orderId, 'items'));
    const depositAmount = item.supplyType === 'bajo_pedido'
      ? Math.round(item.price * item.quantity * BACKORDER_DEPOSIT_PERCENT)
      : 0;

    batch.set(itemRef, {
      productId: item.productId,
      variantId: item.variantId,
      productName: item.productName,
      variantName: item.variantName,
      imageUrl: item.imageUrl || '',
      price: item.price,
      quantity: item.quantity,
      subtotal: item.price * item.quantity,
      supplyType: item.supplyType || 'stock_propio',
      depositAmount,
    });
  }

  await batch.commit();
  return { orderId, orderNumber };
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
