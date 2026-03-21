import { httpsCallable } from 'firebase/functions';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { functions, storage } from '../firebase';

/**
 * Enviar comprobante de pago (sube archivo a Storage + notifica al callable)
 * @param {string} orderId
 * @param {File} file - Archivo de imagen del comprobante
 * @param {object} paymentData - { paymentPhone, transactionId, amount, date }
 */
export async function submitPaymentProof(orderId, file, paymentData = {}) {
  let proofUrl = '';

  if (file) {
    // Subir a Firebase Storage
    const storageRef = ref(storage, `payment_proofs/${orderId}/${file.name}`);
    const snapshot = await uploadBytes(storageRef, file);
    proofUrl = await getDownloadURL(snapshot.ref);
  }

  // Llamar callable para registrar el comprobante
  const submitFn = httpsCallable(functions, 'submitPaymentProof');
  const result = await submitFn({
    orderId,
    proofUrl,
    paymentPhone: paymentData.paymentPhone || '',
    transactionId: paymentData.transactionId || '',
    amount: paymentData.amount || 0,
    date: paymentData.date || new Date().toISOString(),
  });

  return result.data;
}

/**
 * Solicitar conciliación automática de pago (SINPE / Transferencia)
 * @param {string} orderId
 * @param {object} paymentData - { amount, phone, date, transactionId, method }
 */
export async function reconcilePayment(orderId, paymentData) {
  const reconcileFn = httpsCallable(functions, 'reconcilePayment');
  const result = await reconcileFn({ orderId, paymentData });
  return result.data;
}

/**
 * Capturar pago PayPal
 * @param {string} orderId - ID del pedido interno
 * @param {string} paypalOrderId - ID de la orden PayPal
 */
export async function capturePayPalOrder(orderId, paypalOrderId) {
  const captureFn = httpsCallable(functions, 'capturePayPalOrder');
  const result = await captureFn({ orderId, paypalOrderId });
  return result.data;
}

/**
 * Aprobar pago manualmente (solo admin)
 * @param {string} orderId
 * @param {string} notes - Notas del admin
 */
export async function approvePaymentManually(orderId, notes = '') {
  const approveFn = httpsCallable(functions, 'approvePaymentManually');
  const result = await approveFn({ orderId, notes });
  return result.data;
}
