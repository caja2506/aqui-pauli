// ==============================================
// Páginas legales de la tienda (BORRADOR).
// Todo lo marcado [CONFIRMAR] lo debe confirmar Carlos antes de publicar.
// ==============================================
import LegalLayout, { CONTACT, Confirm, Section } from '../../components/legal/LegalLayout';

const UPDATED = '[CONFIRMAR: fecha de publicación]';

function ContactLine() {
  return (
    <p>
      WhatsApp: <a className="font-bold text-rose-600" href={CONTACT.whatsappUrl} target="_blank" rel="noopener noreferrer">{CONTACT.whatsappLabel}</a>
      {' · '}Correo: <a className="font-bold text-rose-600" href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
    </p>
  );
}

export function TerminosPage() {
  return (
    <LegalLayout title="Términos y condiciones" updated={UPDATED}>
      <Section title="1. Quiénes somos">
        <p>
          Aquí Pauli (aquipauli.com) es una tienda en línea de Costa Rica operada por {CONTACT.owner}, persona física
          con domicilio en {CONTACT.place}. Cédula: <Confirm>¿se publica la cédula? Tilopay y Hacienda ya la tienen</Confirm>.
        </p>
        <ContactLine />
      </Section>
      <Section title="2. Productos y precios">
        <p>Los precios se muestran en colones costarricenses (₡) e incluyen el envío a todo el país. <Confirm>¿Los precios incluyen IVA?</Confirm></p>
        <p>Nos reservamos el derecho de corregir errores evidentes de precio o de inventario. Si un producto se agota después de tu pedido, te contactamos para ofrecerte cambio o reembolso completo.</p>
        <p>Las fotos son ilustrativas; las marcas y modelos son los indicados en cada ficha de producto.</p>
      </Section>
      <Section title="3. Cómo comprar">
        <p>Agregas productos al carrito, completas tus datos de contacto y la dirección de entrega, eliges el método de pago y confirmas el pedido. Recibirás un número de pedido para cualquier consulta.</p>
        <p>El pedido se confirma cuando recibimos el pago, o cuando aceptamos el pago contra entrega (ver Envíos).</p>
      </Section>
      <Section title="4. Métodos de pago">
        <ul className="list-disc pl-5 space-y-1">
          <li>SINPE Móvil y transferencia bancaria (envías el comprobante por WhatsApp).</li>
          <li>PayPal o tarjeta, cobrado en dólares al tipo de cambio de referencia que se muestra antes de pagar.</li>
          <li>Tarjeta de crédito o débito en colones, procesada por Tilopay <Confirm>activar este punto solo cuando Tilopay esté aprobado</Confirm>.</li>
          <li>Pago contra entrega, donde esté disponible (ver Envíos) <Confirm>¿contra entrega se paga en efectivo, SINPE o ambos?</Confirm>.</li>
        </ul>
        <p>No vemos ni guardamos los datos de tu tarjeta: el pago lo procesa la pasarela de pago, en su página segura.</p>
      </Section>
      <Section title="5. Envíos, devoluciones y reembolsos">
        <p>Las condiciones están en las páginas de <a className="font-bold text-rose-600" href="/envios">Envíos y entregas</a> y <a className="font-bold text-rose-600" href="/devoluciones">Devoluciones y reembolsos</a>, que forman parte de estos términos.</p>
      </Section>
      <Section title="6. Garantía y reclamos">
        <p>Si recibes un producto dañado, equivocado o distinto a lo descrito, escríbenos por WhatsApp o correo con tu número de pedido y fotos. Atendemos reclamos de lunes a sábado <Confirm>horario de atención</Confirm> y respondemos en <Confirm>plazo de respuesta, por ejemplo 2 días hábiles</Confirm>.</p>
        <p>Garantía de productos: <Confirm>¿aplica garantía en perfumes, tenis y carteras? ¿cuánto tiempo?</Confirm></p>
        <p>Tus derechos como consumidor bajo la Ley de Promoción de la Competencia y Defensa Efectiva del Consumidor (Ley 7472) se mantienen en todo momento.</p>
      </Section>
      <Section title="7. Facturación">
        <p>Emitimos comprobante electrónico de tu compra <Confirm>¿se envía factura electrónica a cada cliente o solo si la piden? Depende de Tico Factura / Hacienda</Confirm>.</p>
      </Section>
      <Section title="8. Datos personales">
        <p>Usamos tus datos solo para gestionar tu pedido y atenderte. Detalles en la <a className="font-bold text-rose-600" href="/privacidad">Política de privacidad</a>.</p>
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
        <p>Puedes solicitar un cambio o devolución dentro de <Confirm>plazo en días, por ejemplo 8 días hábiles desde que recibes el pedido</Confirm>.</p>
        <p>Para solicitarla, escríbenos por WhatsApp ({CONTACT.whatsappLabel}) o a {CONTACT.email} con tu número de pedido y, si aplica, fotos del producto.</p>
      </Section>
      <Section title="2. Condiciones del producto">
        <ul className="list-disc pl-5 space-y-1">
          <li>El producto debe estar sin uso, en su empaque original y con sus accesorios.</li>
          <li>Perfumes: por higiene y seguridad, <Confirm>¿se aceptan devoluciones de perfumes abiertos o usados? ¿solo si están sellados?</Confirm>.</li>
          <li>Tenis, carteras y bolsos: <Confirm>¿cambio de talla? ¿se acepta si tiene señales de uso?</Confirm>.</li>
        </ul>
      </Section>
      <Section title="3. Producto dañado, equivocado o defectuoso">
        <p>Si el producto llega dañado, es distinto al que pediste o tiene un defecto, lo cambiamos por uno igual o te devolvemos el dinero, a tu elección, y nosotros cubrimos el envío de ida y vuelta. Avísanos dentro de <Confirm>plazo para reportar daños, por ejemplo 48 horas</Confirm> con fotos.</p>
      </Section>
      <Section title="4. Quién paga el envío de la devolución">
        <p>Por cambio de opinión o talla: <Confirm>¿lo paga el cliente? ¿se descuenta el envío del reembolso?</Confirm>. Por error nuestro o producto defectuoso: lo pagamos nosotros.</p>
      </Section>
      <Section title="5. Reembolsos">
        <p>El reembolso se hace por el mismo medio de pago que usaste, en un plazo de <Confirm>plazo de reembolso, por ejemplo 5 días hábiles desde que recibimos y revisamos el producto</Confirm>.</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>SINPE o transferencia: devolvemos a la cuenta o número desde el que pagaste.</li>
          <li>PayPal o tarjeta: se reversa al mismo método; el banco puede tardar días adicionales en reflejarlo.</li>
          <li>Pago contra entrega: <Confirm>¿cómo se reembolsa? ¿SINPE?</Confirm>.</li>
        </ul>
      </Section>
      <Section title="6. Cancelación antes del envío">
        <p>Puedes cancelar tu pedido antes de que salga en envío, escribiéndonos con tu número de pedido, y te reembolsamos el 100 %. <Confirm>¿hay un límite de tiempo para cancelar?</Confirm></p>
      </Section>
      <Section title="7. Contracargos y disputas">
        <p>Si tienes un problema con tu compra, escríbenos primero: lo resolvemos rápido. También conservas tus derechos ante tu banco y ante el Ministerio de Economía, Industria y Comercio (MEIC) como consumidor.</p>
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
          <li>Gran Área Metropolitana: <Confirm>días hábiles, por ejemplo 1 a 3</Confirm>.</li>
          <li>Grecia y zonas cercanas (envío express, cuando esté disponible): <Confirm>tiempo y zonas</Confirm>.</li>
          <li>Resto del país: <Confirm>días hábiles, por ejemplo 3 a 6</Confirm>.</li>
          <li>Los plazos cuentan desde que se confirma tu pedido o tu pago. <Confirm>¿Qué días y a qué hora salen los despachos?</Confirm></li>
          <li>Productos bajo pedido (no en stock): <Confirm>tiempo de entrega adicional</Confirm>.</li>
        </ul>
      </Section>
      <Section title="3. Pago contra entrega">
        <p>Ofrecemos pago contra entrega en la mayoría del país: pagas cuando recibes tu pedido.</p>
        <p>No está disponible contra entrega:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Los envíos hechos por Correos de Costa Rica.</li>
          <li>Zonas muy alejadas, donde el pago debe hacerse por adelantado.</li>
        </ul>
        <p>En esos casos el pedido se paga antes del envío (SINPE Móvil, transferencia, PayPal o tarjeta). Si tu zona es de pago por adelantado, te lo indicamos antes de despachar. <Confirm>¿Cómo se determina “zona muy alejada”? ¿Hay una lista de cantones o distritos?</Confirm></p>
      </Section>
      <Section title="4. Mensajería">
        <p>Enviamos con <Confirm>mensajería o empresas de envío que se usan, por ejemplo mensajería propia / Correos de Costa Rica / otras</Confirm>. Te avisamos por WhatsApp cuando tu pedido sale, <Confirm>¿se envía número de guía?</Confirm>.</p>
      </Section>
      <Section title="5. Recepción del pedido">
        <ul className="list-disc pl-5 space-y-1">
          <li>Revisa que el paquete esté en buen estado al recibirlo. Si ves daño evidente, avísanos de inmediato.</li>
          <li>Si nadie recibe el pedido, intentamos contactarte por WhatsApp. <Confirm>¿Cuántos intentos de entrega? ¿Qué pasa si no se recibe?</Confirm></li>
          <li>Es importante que las señas de tu dirección y tu teléfono estén correctos.</li>
        </ul>
      </Section>
      <Section title="6. Seguimiento y consultas">
        <ContactLine />
      </Section>
    </LegalLayout>
  );
}

export function PrivacidadPage() {
  return (
    <LegalLayout title="Política de privacidad" updated={UPDATED}>
      <Section title="1. Responsable de los datos">
        <p>{CONTACT.owner}, persona física, {CONTACT.place}, titular de Aquí Pauli (aquipauli.com). Contacto para temas de privacidad: {CONTACT.email}.</p>
      </Section>
      <Section title="2. Qué datos recopilamos">
        <ul className="list-disc pl-5 space-y-1">
          <li>Datos de contacto: nombre, correo, teléfono y, si lo ingresas, cédula.</li>
          <li>Dirección de entrega.</li>
          <li>Datos de tus pedidos y de tu conversación con nosotros por WhatsApp.</li>
          <li>Si inicias sesión con Google o Facebook: tu nombre y correo, según lo que autorices en ese servicio <Confirm>solo si se activa el login con Facebook</Confirm>.</li>
        </ul>
        <p>No recopilamos ni guardamos números de tarjeta: los pagos con tarjeta los procesa la pasarela de pago (por ejemplo PayPal o Tilopay) en su propia página segura.</p>
      </Section>
      <Section title="3. Para qué los usamos">
        <ul className="list-disc pl-5 space-y-1">
          <li>Procesar y entregar tu pedido, y confirmar tu pago.</li>
          <li>Comunicarnos contigo sobre tu pedido (WhatsApp o correo).</li>
          <li>Emitir comprobantes y cumplir obligaciones fiscales.</li>
          <li>Atender garantías, devoluciones y reclamos.</li>
          <li>Mejorar la tienda. <Confirm>¿se envían promociones o publicidad? Si sí, ¿cómo se pide el permiso y cómo se cancela?</Confirm></li>
        </ul>
      </Section>
      <Section title="4. Con quién los compartimos">
        <p>Solo con quienes necesitamos para operar: la pasarela de pago, la empresa de mensajería que entrega tu pedido, y proveedores de infraestructura (Google Firebase, donde se aloja la tienda). <Confirm>Confirmar si se usa otro proveedor: Meta/WhatsApp para atención, Google Analytics, etc.</Confirm> No vendemos tus datos.</p>
      </Section>
      <Section title="5. Tus derechos">
        <p>Conforme a la Ley de Protección de la Persona frente al tratamiento de sus datos personales (Ley 8968), puedes pedir acceso, rectificación o eliminación de tus datos, y retirar tu consentimiento, escribiendo a {CONTACT.email} o por WhatsApp ({CONTACT.whatsappLabel}). <Confirm>plazo de respuesta, por ejemplo 10 días hábiles</Confirm></p>
      </Section>
      <Section title="6. Conservación y seguridad">
        <p>Guardamos tus datos mientras sean necesarios para atender tu compra y las obligaciones legales y fiscales aplicables <Confirm>tiempo de conservación</Confirm>. La tienda usa conexión cifrada (HTTPS) y acceso restringido a la información.</p>
      </Section>
      <Section title="7. Cookies y almacenamiento local">
        <p>Usamos almacenamiento del navegador para mantener tu carrito y tu sesión. <Confirm>¿Se usa Google Analytics, Meta Pixel u otra herramienta de medición? Si sí, hay que mencionarlo aquí.</Confirm></p>
      </Section>
      <Section title="8. Cambios">
        <p>Si cambiamos esta política, publicaremos la nueva versión en esta página con su fecha.</p>
      </Section>
    </LegalLayout>
  );
}
