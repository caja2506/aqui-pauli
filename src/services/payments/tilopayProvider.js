import { CreditCard } from 'lucide-react';
import { tilopayGetConfig } from './tilopayClient';
import TilopayPanel from '../../components/payments/TilopayPanel';

const TEST_FLAG_KEY = 'aqp_tilopay_test';

function testEnabledForThisBrowser() {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('tilopay_test') === '1') sessionStorage.setItem(TEST_FLAG_KEY, '1');
    if (q.get('tilopay_test') === '0') sessionStorage.removeItem(TEST_FLAG_KEY);
    return sessionStorage.getItem(TEST_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export const tilopayProvider = {
  id: 'tilopay',
  kind: 'online',
  label: 'Tarjeta de crédito o débito (Tilopay, colones)',
  icon: CreditCard,
  Panel: TilopayPanel,
  /**
   * Apagado por defecto: requiere Firestore config/payments.tilopay.enabled === true.
   * En modo "test" solo aparece al entrar con /checkout?tilopay_test=1.
   * Si las funciones no están desplegadas, la llamada falla y la opción no se muestra.
   */
  async getAvailability() {
    try {
      const cfg = await tilopayGetConfig();
      if (!cfg?.enabled) return { available: false };
      if (cfg.mode === 'test' && !testEnabledForThisBrowser()) return { available: false };
      return { available: true, ...cfg };
    } catch (err) {
      console.warn('Tilopay no disponible:', err);
      return { available: false };
    }
  },
};
