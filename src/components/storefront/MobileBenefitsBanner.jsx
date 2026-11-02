import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tilopayGetConfig } from '../../services/payments/tilopayClient';

export default function MobileBenefitsBanner() {
  const [tilopayLive, setTilopayLive] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const viewport = useRef(null);
  const label = useRef(null);
  const message = '🚚 Envío gratis · 💵 Pago contra entrega · ' + (tilopayLive
    ? '💳 Tarjeta de crédito/débito, PayPal · Tasa Cero y Minicuotas BAC'
    : 'PayPal');

  useEffect(() => {
    let active = true;
    // Consultar como público, incluso si este navegador tiene una invitación al piloto.
    tilopayGetConfig({}).then(config => {
      if (active) setTilopayLive(config?.enabled === true && config.mode === 'live');
    }).catch(() => { /* Mantener solo las ventajas públicas si no hay conexión. */ });
    return () => { active = false; };
  }, []);

  useLayoutEffect(() => {
    const measure = () => setOverflows(label.current.offsetWidth > viewport.current.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current);
    observer.observe(label.current);
    return () => observer.disconnect();
  }, [message]);

  return (
    <div className="bg-rose-50 px-2 py-1 text-xs font-semibold leading-4 text-rose-900">
      <div ref={viewport} className="benefits-viewport" data-overflow={overflows} tabIndex={overflows ? 0 : undefined}>
        <div className="benefits-track">
          <span ref={label}>{message}</span>
          {overflows && <span aria-hidden="true">{message}</span>}
        </div>
      </div>
    </div>
  );
}
