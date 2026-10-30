// ==============================================
// Páginas legales de la tienda: términos, devoluciones, envíos y privacidad.
// ==============================================
import { Link } from 'react-router-dom';
import LegalLayout, { CONTACT, LAST_UPDATED, Section } from '../../components/legal/LegalLayout';
import { SHIPPING_DELIVERY_TIMES } from '../../utils/shippingDelivery';

const UPDATED = '30 de octubre de 2026';
const A = 'font-bold text-rose-600 hover:text-rose-700';

function ContactLine() {
  return (
    <p>
      WhatsApp: <a className={A} href={CONTACT.whatsappUrl} target="_blank" rel="noopener noreferrer">{CONTACT.whatsappLabel}</a>
      {' · '}Correo: <a className={A} href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
    </p>
  );
}

function MerchantInfo() {
  return (
    <ul className="list-disc pl-5 space-y-1" data-testid="merchant-info">
      <li>Nombre: {CONTACT.owner}</li>
      <li>Cédula de identidad: {CONTACT.cedula}</li>
      <li>Nombre comercial: {CONTACT.tradeName}</li>
      <li>Ubicación: {CONTACT.fullPlace}</li>
      <li>WhatsApp: <a className={A} href={CONTACT.whatsappUrl} target="_blank" rel="noopener noreferrer">{CONTACT.whatsappLabel}</a></li>
      <li>Correo: <a className={A} href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a></li>
      <li>Sitio web: {CONTACT.site}</li>
      <li>Inscrito en el Ministerio de Hacienda (régimen simplificado).</li>
    </ul>
  );
}

export function TerminosPage() {
  return (
    <LegalLayout title="Términos y condiciones" updated={UPDATED}>
      <Section title="Información del comerciante">
        <MerchantInfo />
      </Section>
      <Section title="1. Quiénes somos">
        <p>
          Aquí Pauli (aquipauli.com) es una tienda en línea de Costa Rica operada por {CONTACT.owner}, persona física
          con domicilio en {CONTACT.place}.
        </p>
        <ContactLine />
        <p>Horario de atención: lunes a sábado, de 9:00 a. m. a 6:00 p. m.</p>
      </Section>
      <Section title="2. Productos y precios">
        <p>Los precios se muestran en colones costarricenses (₡), incluyen IVA cuando corresponda e incluyen el envío a todo el país.</p>
        <p>Nos reservamos el derecho de corregir errores evidentes de precio o de inventario. Si un producto se agota después de tu pedido, te contactamos para ofrecerte un cambio o el reembolso completo.</p>
        <p>Las fotos son ilustrativas; las marcas y modelos son los indicados en cada ficha de producto.</p>
      </Section>
      <Section title="3. Cómo comprar">
        <p>Agregas productos al carrito, completas tus datos de contacto y la dirección de entrega, eliges el método de pago y confirmas el pedido. Recibirás un número de pedido para cualquier consulta.</p>
        <p>El pedido queda registrado al confirmar la compra. El pago se confirma cuando recibimos el importe indicado al finalizar la compra (ver <Link className={A} to="/envios">Envíos y entregas</Link>).</p>
      </Section>
      <Section title="4. Métodos de pago">
        <ul className="list-disc pl-5 space-y-1">
          <li>SINPE Móvil y transferencia bancaria (envías el comprobante por WhatsApp).</li>
          <li>PayPal, cobrado en dólares al tipo de cambio de referencia que se muestra antes de pagar.</li>
          <li>Tarjeta de crédito o débito en colones: próximamente.</li>
          <li>Contra entrega en efectivo: disponible cuando todos los productos del pedido están en stock. Pagás el monto completo al recibir, sin adelanto.</li>
        </ul>
        <p>Si el carrito incluye productos Bajo pedido, el pago inicial incluye el 50% de esas líneas y el importe completo de las líneas en stock. En esos pedidos no se ofrece contra entrega; el saldo de los productos Bajo pedido se paga cuando el pedido esté listo para entregarse.</p>
        <p>No vemos ni guardamos los datos de tu tarjeta: los pagos con tarjeta los procesa la pasarela de pago, en su página segura.</p>
      </Section>
      <Section title="5. Envíos, devoluciones y reembolsos">
        <p>Las condiciones están en las páginas de <Link className={A} to="/envios">Envíos y entregas</Link> y <Link className={A} to="/devoluciones">Devoluciones y reembolsos</Link>, que forman parte de estos términos.</p>
      </Section>
      <Section title="6. Garantía y reclamos">
        <p>Si recibes un producto dañado, equivocado o distinto a lo descrito, escríbenos por WhatsApp o correo con tu número de pedido y fotos. Respondemos los reclamos en un máximo de 2 días hábiles.</p>
        <p>Los daños o errores en la entrega deben reportarse dentro de las 48 horas siguientes a recibir el pedido (ver <Link className={A} to="/devoluciones">Devoluciones y reembolsos</Link>).</p>
        <p>Tus derechos como consumidor bajo la Ley de Promoción de la Competencia y Defensa Efectiva del Consumidor (Ley 7472) se mantienen en todo momento.</p>
      </Section>
      <Section title="7. Facturación">
        <p>Emitimos factura electrónica de tu compra si la solicitas por WhatsApp o correo, indicando tus datos de facturación y tu número de pedido.</p>
      </Section>
      <Section title="8. Datos personales">
        <p>Usamos tus datos solo para gestionar tu pedido y atenderte. Detalles en la <Link className={A} to="/privacidad">Política de privacidad</Link>.</p>
      </Section>
      <Section title="9. Cambios a estos términos">
        <p>Podemos actualizar estos términos; la versión vigente es la publicada en esta página, con su fecha de actualización. Los pedidos ya hechos se rigen por los términos vigentes al momento de la compra.</p>
      </Section>
      <Section title="10. Ley aplicable">
        <p>Estos términos se rigen por las leyes de la República de Costa Rica.</p>
      </Section>
    </LegalLayout>
  );
}

export function DevolucionesPage() {
  return (
    <LegalLayout title="Devoluciones y reembolsos" updated={UPDATED}>
      <Section title="1. Plazo para solicitar una devolución">
        <p>Puedes solicitar un cambio o devolución dentro de los 8 días naturales siguientes a recibir tu pedido.</p>
        <p>Para solicitarla, escríbenos por WhatsApp ({CONTACT.whatsappLabel}) o a {CONTACT.email} con tu número de pedido y, si aplica, fotos del producto. Atendemos de lunes a sábado, de 9:00 a. m. a 6:00 p. m., y respondemos en un máximo de 2 días hábiles.</p>
      </Section>
      <Section title="2. Condiciones del producto">
        <ul className="list-disc pl-5 space-y-1">
          <li>El producto debe estar sin uso, en su empaque original y con sus accesorios.</li>
          <li><strong>Perfumes:</strong> por higiene y seguridad, solo se aceptan devoluciones si el perfume está sellado, salvo que haya llegado dañado o que sea un producto equivocado.</li>
          <li><strong>Tenis, carteras y bolsos:</strong> aceptamos cambio de talla si el producto está sin uso.</li>
        </ul>
      </Section>
      <Section title="3. Producto dañado o equivocado">
        <p>Si el producto llega dañado o es distinto al que pediste, lo cambiamos por uno igual o te devolvemos el dinero, a tu elección, y nosotros cubrimos el envío de ida y vuelta. Debes reportarlo dentro de las 48 horas siguientes a recibir el pedido, con fotos del producto y del empaque.</p>
      </Section>
      <Section title="4. Quién paga el envío de la devolución">
        <p>Si es por cambio de opinión o cambio de talla, el envío de devolución lo paga el cliente. Si es por daño, error nuestro o producto equivocado, lo pagamos nosotros.</p>
      </Section>
      <Section title="5. Reembolsos">
        <p>Una vez recibido y revisado el producto, hacemos el reembolso en un máximo de 5 días hábiles, por el mismo medio de pago que usaste.</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>SINPE o transferencia: devolvemos a la cuenta o número desde el que pagaste.</li>
          <li>PayPal o tarjeta: se reversa al mismo método; tu banco o PayPal puede tardar días adicionales en reflejarlo.</li>
        </ul>
      </Section>
      <Section title="6. Cancelación antes del envío">
        <p>Puedes cancelar tu pedido antes de que sea despachado, escribiéndonos con tu número de pedido, y te reembolsamos el 100 % de lo que hayas pagado. Una vez despachado, aplican las condiciones de devolución de esta página.</p>
      </Section>
      <Section title="7. Disputas">
        <p>Si tienes un problema con tu compra, escríbenos primero: lo resolvemos lo antes posible. También conservas tus derechos como consumidor ante tu banco y ante el Ministerio de Economía, Industria y Comercio (MEIC).</p>
      </Section>
    </LegalLayout>
  );
}

export function EnviosPage() {
  return (
    <LegalLayout title="Envíos y entregas" updated={UPDATED}>
      <Section title="1. Envío incluido a todo el país">
        <p>El envío está incluido en el precio de tus productos: no pagas nada extra por el envío, vivas donde vivas en Costa Rica.</p>
      </Section>
      <Section title="2. Tiempos de entrega">
        <ul className="list-disc pl-5 space-y-1">
          <li>Envío normal en la Gran Área Metropolitana: {SHIPPING_DELIVERY_TIMES.normalGAM}.</li>
          <li>Envío normal en el resto del país: {SHIPPING_DELIVERY_TIMES.normalOutside}.</li>
          <li>Envío express en Grecia: {SHIPPING_DELIVERY_TIMES.expressGrecia}.</li>
        </ul>
        <p>Los plazos se cuentan en días hábiles desde que se confirma tu pedido o tu pago. Si algún producto necesita más tiempo, te avisamos por WhatsApp antes del despacho.</p>
      </Section>
      <Section title="3. Pago del pedido">
        <p>Elegís entre los métodos disponibles al finalizar la compra. Si todos los productos están en stock, podés elegir contra entrega en efectivo: pagás el monto completo al recibir, sin adelanto. También podés pagar antes de la entrega por SINPE Móvil, transferencia o PayPal.</p>
        <p>Si tu pedido incluye productos Bajo pedido, no se ofrece contra entrega. El pago inicial incluye el 50% de esas líneas y el importe completo de las líneas en stock. El resumen de la compra muestra el monto a pagar ahora y el saldo pendiente.</p>
        <p>El saldo de los productos Bajo pedido se paga cuando el pedido esté listo para entregarse. Te avisamos por WhatsApp antes de despacharlo.</p>
      </Section>
      <Section title="4. Mensajería">
        <p>Enviamos con mensajería local y con Correos de Costa Rica, según tu zona. Te avisamos por WhatsApp cuando tu pedido sale y, si el servicio de envío la genera, te compartimos la guía de seguimiento.</p>
      </Section>
      <Section title="5. Recepción del pedido">
        <ul className="list-disc pl-5 space-y-1">
          <li>Revisa que el paquete esté en buen estado al recibirlo. Si ves daño evidente, avísanos de inmediato y reporta cualquier daño dentro de las 48 horas siguientes.</li>
          <li>Si nadie recibe el pedido, te contactamos por WhatsApp para coordinar una nueva entrega.</li>
          <li>Es importante que las señas de tu dirección y tu teléfono estén correctos.</li>
        </ul>
      </Section>
      <Section title="6. Seguimiento y consultas">
        <ContactLine />
        <p>Horario de atención: lunes a sábado, de 9:00 a. m. a 6:00 p. m.</p>
      </Section>
    </LegalLayout>
  );
}

export function PrivacidadPage() {
  return (
    <LegalLayout title="Política de privacidad" updated={LAST_UPDATED}>
      <Section title="1. Responsable de los datos">
        <p>El responsable de la base de datos es {CONTACT.owner}, cédula de identidad {CONTACT.cedula}, persona física, titular de Aquí Pauli (aquipauli.com), con domicilio en Grecia, Alajuela, Costa Rica.</p>
        <p>
          Contacto para temas de privacidad: WhatsApp <a className={A} href={CONTACT.whatsappUrl} target="_blank" rel="noopener noreferrer">{CONTACT.whatsappLabel}</a>
          {' · '}correo <a className={A} href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>.
        </p>
      </Section>
      <Section title="2. Qué datos recopilamos">
        <ul className="list-disc pl-5 space-y-1">
          <li>Datos de contacto: nombre, correo, teléfono y, si lo ingresas, cédula.</li>
          <li>Dirección de entrega.</li>
          <li>Datos de tus pedidos y de tu conversación con nosotros por WhatsApp.</li>
          <li>Si inicias sesión con Google o Facebook: tu nombre y correo, según lo que autorices en ese servicio.</li>
        </ul>
        <p>No recopilamos ni guardamos números de tarjeta: los pagos con tarjeta los procesa la pasarela de pago en su propia página segura.</p>
      </Section>
      <Section title="3. Para qué los usamos">
        <ul className="list-disc pl-5 space-y-1">
          <li>Procesar y entregar tu pedido, y confirmar tu pago.</li>
          <li>Comunicarnos contigo sobre tu pedido (WhatsApp o correo).</li>
          <li>Emitir comprobantes y cumplir obligaciones fiscales.</li>
          <li>Atender garantías, devoluciones y reclamos.</li>
          <li>Enviarte promociones, solo si nos diste tu consentimiento. Puedes dejar de recibirlas en cualquier momento escribiéndonos por WhatsApp o a {CONTACT.email}.</li>
        </ul>
      </Section>
      <Section title="4. Con quién los compartimos">
        <p>Solo con los proveedores que necesitamos para operar (encargados del tratamiento):</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Meta / WhatsApp, para atenderte y comunicarnos contigo.</li>
          <li>PayPal y Tilopay, para procesar los pagos.</li>
          <li>Firebase / Google, donde se aloja la tienda y se guardan los pedidos.</li>
          <li>La empresa de mensajería que entrega tu pedido (nombre, teléfono y dirección).</li>
        </ul>
        <p>No vendemos tus datos.</p>
      </Section>
      <Section title="5. Tus derechos">
        <p>Conforme a la Ley de Protección de la Persona frente al tratamiento de sus datos personales (Ley 8968), puedes pedir acceso, rectificación o eliminación de tus datos, y retirar tu consentimiento, escribiendo a {CONTACT.email} o por WhatsApp ({CONTACT.whatsappLabel}). Respondemos en un máximo de 10 días hábiles.</p>
      </Section>
      <Section title="6. Conservación y seguridad">
        <p>Guardamos tus datos el tiempo que la ley exija. La tienda usa conexión cifrada (HTTPS) y acceso restringido a la información.</p>
      </Section>
      <Section title="7. Cookies y almacenamiento local">
        <p>Usamos el almacenamiento de tu navegador para mantener tu carrito y tu sesión. No usamos herramientas de publicidad ni de análisis de terceros en la tienda.</p>
      </Section>
      <Section title="8. Cambios">
        <p>Si cambiamos esta política, publicaremos la nueva versión en esta página con su fecha.</p>
      </Section>
    </LegalLayout>
  );
}
