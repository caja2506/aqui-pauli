import { collection, doc, setDoc, updateDoc, writeBatch, serverTimestamp, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { generateOrderNumber } from '../utils/formatters';

/**
 * Crea un pedido completo:
 * - Documento principal en orders/ con dirección, totales, cliente
 * - Sub-colección orders/{id}/items/ con cada producto
 * - Crea/actualiza contacto en crm_contacts/
 */
export async function createOrder(orderData) {
  const orderId = doc(collection(db, 'orders')).id;
  const orderNumber = generateOrderNumber();
  const now = new Date().toISOString();
  const batch = writeBatch(db);

  // --- 1. Documento principal de la orden ---
  const orderRef = doc(db, 'orders', orderId);
  const total = (orderData.subtotal || 0) + (orderData.shippingCost || 0);

  // Calcular si hay productos bajo pedido (backorder)
  const hasBackorder = orderData.items.some(i => i.supplyType === 'bajo_pedido');
  const backorderDeposit = hasBackorder ? Math.round(total * 0.2) : 0;

  batch.set(orderRef, {
    orderNumber,
    uid: orderData.uid || '',
    customerName: orderData.customerName,
    customerEmail: orderData.customerEmail,
    customerPhone: orderData.customerPhone,
    // --- DIRECCIÓN COMPLETA ---
    shippingAddress: {
      provincia: orderData.shippingAddress?.provincia || '',
      canton: orderData.shippingAddress?.canton || '',
      distrito: orderData.shippingAddress?.distrito || '',
      codigoPostal: orderData.shippingAddress?.codigoPostal || '',
      señas: orderData.shippingAddress?.señas || '',
    },
    // --- TOTALES ---
    subtotal: orderData.subtotal,
    shippingCost: orderData.shippingCost,
    shippingType: orderData.shippingType || 'normal',
    total,
    // --- PAGO ---
    paymentMethod: orderData.paymentMethod,
    paymentPhone: orderData.paymentPhone || '',
    paymentStatus: 'pendiente',
    paymentProofUrl: '',
    // --- BACKORDER ---
    hasBackorder,
    backorderDeposit,
    // --- ESTADO ---
    status: 'pendiente_pago',
    notes: '',
    trackingNumber: '',
    trackingUrl: '',
    // --- ITEMS RESUMEN (para mostrar en la tabla sin sub-query) ---
    itemsSummary: orderData.items.map(i => ({
      productId: i.productId,
      variantId: i.variantId,
      productName: i.productName,
      variantName: i.variantName,
      imageUrl: i.imageUrl || '',
      price: i.price,
      quantity: i.quantity,
      supplyType: i.supplyType || 'stock_propio',
      lineTotal: i.price * i.quantity,
    })),
    itemCount: orderData.items.reduce((sum, i) => sum + i.quantity, 0),
    // --- TIMESTAMPS ---
    createdAt: now,
    updatedAt: now,
  });

  // --- 2. Sub-colección de items (para queries detallados) ---
  orderData.items.forEach((item, index) => {
    const itemRef = doc(db, 'orders', orderId, 'items', `item_${index}`);
    batch.set(itemRef, {
      productId: item.productId,
      variantId: item.variantId,
      productName: item.productName,
      variantName: item.variantName,
      imageUrl: item.imageUrl || '',
      price: item.price,
      quantity: item.quantity,
      supplyType: item.supplyType || 'stock_propio',
      lineTotal: item.price * item.quantity,
    });
  });

  // --- 3. Crear/actualizar contacto CRM ---
  if (orderData.uid) {
    const crmRef = doc(db, 'crm_contacts', orderData.uid);
    batch.set(crmRef, {
      uid: orderData.uid,
      email: orderData.customerEmail,
      displayName: orderData.customerName,
      phone: orderData.customerPhone,
      lastAddress: {
        provincia: orderData.shippingAddress?.provincia || '',
        canton: orderData.shippingAddress?.canton || '',
        distrito: orderData.shippingAddress?.distrito || '',
        codigoPostal: orderData.shippingAddress?.codigoPostal || '',
        señas: orderData.shippingAddress?.señas || '',
      },
      funnelStage: 'comprador',
      lastOrderId: orderId,
      lastOrderDate: now,
      updatedAt: now,
    }, { merge: true });
  }

  await batch.commit();

  return { orderId, orderNumber };
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
