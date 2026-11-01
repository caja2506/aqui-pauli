import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { db } from '../firebase';

export async function readPixelVariant(productId, variantId) {
  const snap = await getDoc(doc(db, 'products', productId, 'variants', variantId));
  return snap.exists() ? { ...snap.data(), id: snap.id } : null;
}

// Algunos pedidos anteriores solo guardaban sus líneas en la subcolección items.
export async function readPixelOrderItems(orderId) {
  const snap = await getDocs(collection(db, 'orders', orderId, 'items'));
  return snap.docs.map(item => item.data());
}
