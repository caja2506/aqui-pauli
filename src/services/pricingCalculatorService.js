import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { validatePricingSettings } from '../utils/pricingCalculator';

const settingsRef = () => doc(db, 'admin_pricing', 'settings');

export async function getPricingSettings() {
  const snapshot = await getDoc(settingsRef());
  return snapshot.exists() ? validatePricingSettings(snapshot.data()) : null;
}

export async function savePricingSettings(input) {
  const settings = validatePricingSettings(input);
  await setDoc(settingsRef(), { ...settings, updatedAt: serverTimestamp() });
  return settings;
}
