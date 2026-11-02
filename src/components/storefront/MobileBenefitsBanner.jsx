import { useEffect, useState } from 'react';
import { tilopayGetConfig } from '../../services/payments/tilopayClient';

export default function MobileBenefitsBanner() {
  const [tilopayLive, setTilopayLive] = useState(false);
  const message = '🚚 Envío gratis · 💵 Pago contra entrega · 💳 Pago con tarjeta de débito y crédito · PayPal'
    + (tilopayLive ? ' · Tasa Cero y Minicuotas BAC' : '');

  useEffect(() => {
    let active = true;
    // Consultar como público, incluso si este navegador tiene una invitación al piloto.
    tilopayGetConfig({}).then(config => {
      if (active) setTilopayLive(config?.enabled === true && config.mode === 'live');
    }).catch(() => { /* Mantener solo las ventajas públicas si no hay conexión. */ });
    return () => { active = false; };
  }, []);

  return (
    <div className="bg-rose-50 px-2 py-1 text-xs font-semibold leading-4 text-rose-900">
      <div className="benefits-viewport" tabIndex={0}>
        <div className="benefits-track">
          <span>{message}</span>
          <span aria-hidden="true">{message}</span>
          <span aria-hidden="true">{message}</span>
        </div>
      </div>
    </div>
  );
}
