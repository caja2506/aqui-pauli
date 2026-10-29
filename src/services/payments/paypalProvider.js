import { CreditCard } from 'lucide-react';
import { paypalGetConfig } from './paypalClient';
import PaypalPanel from '../../components/payments/PaypalPanel';

const SANDBOX_FLAG_KEY = 'aqp_paypal_sandbox';

function sandboxEnabledForThisBrowser() {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('paypal_sandbox') === '1') sessionStorage.setItem(SANDBOX_FLAG_KEY, '1');
    if (q.get('paypal_sandbox') === '0') sessionStorage.removeItem(SANDBOX_FLAG_KEY);
    return sessionStorage.getItem(SANDBOX_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export const paypalProvider = {
  id: 'paypal',
  kind: 'online',
  label: 'PayPal / Tarjeta (USD)',
  icon: CreditCard,
  Panel: PaypalPanel,
  /**
   * En sandbox la opción solo aparece si se entra con ?paypal_sandbox=1
   * (así el público no ve un PayPal de pruebas). En live aparece siempre,
   * salvo que config/payments.paypal.enabled sea false.
   */
  async getAvailability() {
    try {
      const cfg = await paypalGetConfig();
      if (!cfg.enabled) return { available: false };
      if (cfg.env !== 'live' && !sandboxEnabledForThisBrowser()) return { available: false };
      return { available: true, ...cfg };
    } catch (err) {
      console.warn('PayPal no disponible:', err);
      return { available: false };
    }
  },
};
