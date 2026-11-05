import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, functions } from '../firebase';
import { httpsCallable } from 'firebase/functions';
import { loadWorkbenchSettings, validateWorkbenchSettings } from '../utils/pricingCalculator';

const settingsRef = () => doc(db, 'admin_pricing', 'settings');

export async function getPricingSettings() {
  const snapshot = await getDoc(settingsRef());
  return loadWorkbenchSettings(snapshot.exists() ? snapshot.data() : null);
}

export async function savePricingSettings(input) {
  const settings = validateWorkbenchSettings(input);
  await setDoc(settingsRef(), { ...settings, updatedAt: serverTimestamp() });
  return settings;
}

export async function getSupplierCatalog() {
  const snapshot = await getDoc(doc(db, 'admin_supplier_catalogs', 'ls'));
  return snapshot.exists() ? snapshot.data() : null;
}

export async function importSupplierCatalog(catalog) {
  const response = await httpsCallable(functions, 'importSupplierCatalog')(catalog);
  return response.data;
}

export async function lookupExternalPrice(url) {
  const response = await httpsCallable(functions, 'lookupExternalPrice')({ url });
  return response.data;
}

export async function getPricingExchangeRate() {
  const response = await httpsCallable(functions, 'getPricingExchangeRate')({});
  return response.data;
}
