import { Link } from 'react-router-dom';
import LegalLayout, { CONTACT, Section } from '../../components/legal/LegalLayout';
import { GIVEAWAY } from '../../services/giveawayService';

const linkClass = 'font-bold text-rose-700 underline underline-offset-4 hover:text-rose-900';

export default function GiveawayRulesPage() {
  return (
    <LegalLayout title="Bases del sorteo de Aquí Pauli" updated="29 de octubre de 2026">
      <Section title="1. Organizador">
        <p>El sorteo es organizado por Aquí Pauli, a nombre de {CONTACT.owner}, con domicilio en {CONTACT.fullPlace}.</p>
        <p>Consultas por mensaje directo a <a href="https://www.instagram.com/aqui.paulina/" target="_blank" rel="noopener noreferrer" className={linkClass}>@aqui.paulina</a>.</p>
      </Section>
      <Section title="2. Plazo de inscripción">
        <p>Desde el jueves 29 de octubre de 2026 a las 12:00 a. m. hasta el sábado 28 de noviembre de 2026 a las 8:00 p. m., hora de Costa Rica (UTC−6).</p>
        <p>Al llegar la hora de cierre no se aceptan nuevas inscripciones. Quienes ya se inscribieron pueden consultar su número ingresando con la misma cuenta.</p>
        <p>El sorteo se realizará el domingo 29 de noviembre de 2026, hora de Costa Rica.</p>
      </Section>
      <Section title="3. Requisitos y participación">
        <p>La participación es gratuita y no requiere una compra. Debés ser mayor de 18 años, tener dirección en Costa Rica y registrarte o ingresar con tu cuenta de la tienda.</p>
        <p>Completá tu nombre, teléfono costarricense de 8 dígitos y correo electrónico; escogé el premio y aceptá las dos casillas obligatorias del formulario.</p>
        <p>Se admite una inscripción por cuenta. Al guardarla recibís un número correlativo de participante; volver a enviar el formulario no genera participaciones adicionales.</p>
        <p>Después de inscribirte, comentá tu número de participante en la publicación del sorteo en Instagram <a href="https://www.instagram.com/aqui.paulina/" target="_blank" rel="noopener noreferrer" className={linkClass}>@aqui.paulina</a>.</p>
      </Section>
      <Section title="4. Elección de premio">
        <p>Podés escoger cualquier colonia o perfume activo publicado en la tienda cuyo precio de venta mostrado sea inferior a ₡50 000. Los productos de ₡50 000 o más no califican.</p>
        <p>Se incluyen colonias con stock, bajo pedido o sin stock. El selector del formulario consulta el catálogo de la tienda y permite buscar por nombre o marca.</p>
        <p>Al inscribirte se verifica el producto y su precio actual. La inscripción guarda la colonia escogida y su precio en ese momento, junto con tu número de participante.</p>
      </Section>
      <Section title="5. Datos personales y consentimiento">
        <p>El responsable del tratamiento es Aquí Pauli ({CONTACT.owner}). Los datos del formulario, el premio elegido, los consentimientos, la fecha y el número de participante se almacenan en la base de datos de la tienda en Firebase para administrar el sorteo y contactarte. El acceso a la lista está reservado al personal administrador autorizado.</p>
        <p>El nombre, el teléfono, el correo, el premio y las dos declaraciones obligatorias son necesarios para tramitar la inscripción. Sin ellos no es posible participar.</p>
        <p>El formulario solicita este consentimiento conforme a la Ley 8968:</p>
        <blockquote className="border-l-4 border-rose-300 pl-4">{GIVEAWAY.privacyConsentText}</blockquote>
        <p>Podés solicitar acceso, rectificación o eliminación de tus datos y retirar tu consentimiento mediante mensaje directo a <a href="https://www.instagram.com/aqui.paulina/" target="_blank" rel="noopener noreferrer" className={linkClass}>@aqui.paulina</a>.</p>
      </Section>
      <Section title="6. Promociones opcionales">
        <p>La autorización para recibir promociones se presenta en una casilla separada, desmarcada inicialmente. Aceptarla es opcional y no cambia tu participación en el sorteo. Solo se usarán tus datos para promociones si lo autorizás.</p>
      </Section>
      <p className="mt-10"><Link to="/sorteo" className={linkClass}>Volver al sorteo</Link></p>
    </LegalLayout>
  );
}
