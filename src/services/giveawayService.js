import { doc, onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../firebase';
import giveaway from '../../functions/lib/giveawayConfig.json';

export const GIVEAWAY = giveaway;

export function giveawayStatus(enabled, now = Date.now()) {
  if (!enabled) return 'disabled';
  if (now < Date.parse(GIVEAWAY.startsAt)) return 'upcoming';
  if (now >= Date.parse(GIVEAWAY.endsAt)) return 'closed';
  return 'active';
}

export function giveawayPrizeLabel(prizeId) {
  return GIVEAWAY.prizes.find((prize) => prize.id === prizeId)?.label || 'Premio registrado';
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
    prizeId: form.prizeId,
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
