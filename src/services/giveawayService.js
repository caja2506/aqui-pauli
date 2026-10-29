import { collection, doc, getDocs, onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../firebase';
import giveaway from '../../functions/lib/giveawayConfig.json';
import { isFragranceProduct, selectGiveawayProduct } from '../../functions/lib/giveawayCatalog.mjs';

export const GIVEAWAY = giveaway;

export function giveawayStatus(enabled, now = Date.now()) {
  if (!enabled) return 'disabled';
  if (now < Date.parse(GIVEAWAY.startsAt)) return 'upcoming';
  if (now >= Date.parse(GIVEAWAY.endsAt)) return 'closed';
  return 'active';
}

export function giveawayPrizeLabel(entryOrId) {
  if (entryOrId && typeof entryOrId === 'object') {
    if (entryOrId.productName) return entryOrId.productName;
    if (entryOrId.prizeLabel) return entryOrId.prizeLabel;
  }
  const prizeId = typeof entryOrId === 'string' ? entryOrId : entryOrId?.prizeId;
  return GIVEAWAY.prizes?.find((prize) => prize.id === prizeId)?.label || 'Premio registrado';
}

export function searchGiveawayProducts(products, search) {
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const terms = normalize(search).split(/\s+/).filter(Boolean);
  return products.filter((product) => terms.every((term) => normalize(product.productName).includes(term)));
}

export async function loadGiveawayProducts() {
  const [productSnapshot, categorySnapshot] = await Promise.all([
    getDocs(collection(db, 'products')), getDocs(collection(db, 'categories')),
  ]);
  const categories = categorySnapshot.docs.map((snapshot) => ({ ...snapshot.data(), id: snapshot.id }));
  const products = productSnapshot.docs.map((snapshot) => ({ ...snapshot.data(), id: snapshot.id }))
    .filter((product) => product.active === true && !product.deleted && !product.unlisted
      && isFragranceProduct(product, categories, GIVEAWAY));
  const choices = await Promise.all(products.map(async (product) => {
    // Un fallo al leer variantes no permite usar un precio base posiblemente distinto.
    const snapshot = await getDocs(collection(db, 'products', product.id, 'variants'));
    const variants = snapshot.docs.map((variant) => ({ ...variant.data(), id: variant.id }));
    return selectGiveawayProduct(product, variants, categories, GIVEAWAY);
  }));
  return choices.filter(Boolean).sort((a, b) => a.productName.localeCompare(b.productName, 'es')
    || a.productId.localeCompare(b.productId));
}

export function watchGiveawayConfig(onValue, onError) {
  return onSnapshot(doc(db, 'config', 'giveaway'), (snapshot) => {
    // La campaña arranca habilitada. Un false explícito la apaga en tiempo real.
    onValue(!snapshot.exists() || snapshot.data().enabled !== false);
  }, onError);
}

export function watchOwnGiveawayEntry(uid, onValue, onError) {
  return onSnapshot(doc(db, 'giveawayEntries', uid), (snapshot) => {
    onValue(snapshot.exists() ? snapshot.data() : null);
  }, onError);
}

export async function enterGiveaway(form) {
  const { data } = await httpsCallable(functions, 'enterGiveaway')({
    fullName: form.fullName,
    phone: form.phone,
    email: form.email,
    productId: form.productId,
    eligibilityAccepted: form.eligibilityAccepted,
    privacyConsent: form.privacyConsent,
    promotionsConsent: form.promotionsConsent,
  });
  if (!Number.isSafeInteger(data?.number) || data.number < 1 || data.campaignId !== GIVEAWAY.campaignId) {
    throw new Error('No pudimos confirmar tu número. Volvé a consultar tu inscripción antes de intentar de nuevo.');
  }
  return data;
}

export function giveawayErrorMessage(error) {
  const code = error?.code?.replace(/^functions\//, '');
  if (code === 'unauthenticated') return 'Ingresá con tu cuenta de la tienda para participar.';
  if (code === 'permission-denied') return 'Para participar necesitás una cuenta registrada. Ingresá o creá tu cuenta.';
  if (code === 'failed-precondition' || code === 'invalid-argument') {
    return error.message || 'Revisá los datos y la disponibilidad del sorteo.';
  }
  return 'No pudimos confirmar tu inscripción. Revisá tu conexión e intentá de nuevo: tu cuenta solo puede recibir un número.';
}
