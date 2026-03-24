// ==============================================
// WhatsApp Business API — Sender
// Envía mensajes al cliente via WhatsApp
// Soporta: texto, botones interactivos, listas, typing indicator
// ==============================================
const { defineSecret } = require("firebase-functions/params");
const fetch = require("node-fetch");

const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");
const WHATSAPP_PHONE_ID = defineSecret("WHATSAPP_PHONE_ID");

// ========== HELPERS INTERNOS ==========

function _normalizePhone(to) {
  return to.startsWith("506") ? to : "506" + to.replace(/\D/g, "");
}

function _getApiUrl() {
  return `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID.value()}/messages`;
}

function _getHeaders() {
  return {
    Authorization: `Bearer ${WHATSAPP_TOKEN.value().replace(/^Bearer\s+/i, '').trim()}`,
    "Content-Type": "application/json",
  };
}

async function _sendPayload(payload) {
  const resp = await fetch(_getApiUrl(), {
    method: "POST",
    headers: _getHeaders(),
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (data.error) {
    console.error("❌ WhatsApp send error:", data.error);
    throw new Error(data.error.message);
  }
  return data;
}

/**
 * Calcula un delay "natural" basado en el largo del mensaje.
 * Simula tiempo de escritura humana (1s–3s).
 */
function _calculateTypingDelay(text) {
  if (!text) return 1000;
  const length = text.length;
  if (length < 50) return 1000;       // Mensaje corto: 1s
  if (length < 150) return 1500;      // Mensaje medio: 1.5s
  if (length < 300) return 2000;      // Mensaje largo: 2s
  return 3000;                        // Mensaje muy largo: 3s
}

/**
 * Espera un delay natural antes de responder.
 * Hace que el bot no conteste instantáneamente (más humano).
 */
async function withTypingDelay(to, text, sendFn) {
  const delay = _calculateTypingDelay(text);
  await new Promise(resolve => setTimeout(resolve, delay));
  return sendFn();
}

// ========== ENVÍO DE TEXTO SIMPLE ==========

/**
 * Envía un mensaje de texto simple por WhatsApp (con delay natural)
 */
async function sendWhatsAppMessage(to, text) {
  const phone = _normalizePhone(to);
  return withTypingDelay(to, text, () =>
    _sendPayload({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text },
    })
  );
}

/**
 * Envía texto sin delay (para notificaciones del sistema que deben ser inmediatas)
 */
async function sendWhatsAppMessageImmediate(to, text) {
  const phone = _normalizePhone(to);
  return _sendPayload({
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { body: text },
  });
}

// ========== BOTONES INTERACTIVOS ==========

/**
 * Envía un mensaje con botones interactivos (máximo 3 botones, límite de WhatsApp).
 *
 * @param {string} to — Teléfono destino
 * @param {string} bodyText — Texto del mensaje
 * @param {Array<{id: string, title: string}>} buttons — Botones (máx 3, título máx 20 chars)
 * @param {string} [headerText] — Texto del header (opcional)
 * @param {string} [footerText] — Texto del footer (opcional)
 */
async function sendInteractiveButtons(to, bodyText, buttons, headerText, footerText) {
  const phone = _normalizePhone(to);

  // Validar límites de WhatsApp
  const validButtons = buttons.slice(0, 3).map(btn => ({
    type: "reply",
    reply: {
      id: (btn.id || btn.title || "btn").substring(0, 256),
      title: (btn.title || "Opción").substring(0, 20),
    },
  }));

  const interactive = {
    type: "button",
    body: { text: bodyText.substring(0, 1024) },
    action: { buttons: validButtons },
  };

  if (headerText) {
    interactive.header = { type: "text", text: headerText.substring(0, 60) };
  }
  if (footerText) {
    interactive.footer = { text: footerText.substring(0, 60) };
  }

  try {
    return await withTypingDelay(to, bodyText, () =>
      _sendPayload({
        messaging_product: "whatsapp",
        to: phone,
        type: "interactive",
        interactive,
      })
    );
  } catch (err) {
    // Si falla el envío de botones, enviar como texto plano
    console.warn(`⚠️ Botones fallaron, enviando como texto: ${err.message}`);
    return _sendPayload({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: bodyText },
    });
  }
}

/**
 * Envía un mensaje con lista desplegable (para más de 3 opciones).
 *
 * @param {string} to — Teléfono destino
 * @param {string} bodyText — Texto del mensaje
 * @param {string} buttonText — Texto del botón que abre la lista (máx 20 chars)
 * @param {Array<{title: string, rows: Array<{id: string, title: string, description?: string}>}>} sections
 * @param {string} [headerText] — Header opcional
 * @param {string} [footerText] — Footer opcional
 */
async function sendInteractiveList(to, bodyText, buttonText, sections, headerText, footerText) {
  const phone = _normalizePhone(to);

  // Validar límites de WhatsApp
  const validSections = sections.slice(0, 10).map(section => ({
    title: (section.title || "Opciones").substring(0, 24),
    rows: (section.rows || []).slice(0, 10).map(row => ({
      id: (row.id || row.title || "row").substring(0, 200),
      title: (row.title || "Opción").substring(0, 24),
      ...(row.description ? { description: row.description.substring(0, 72) } : {}),
    })),
  }));

  const interactive = {
    type: "list",
    body: { text: bodyText.substring(0, 1024) },
    action: {
      button: (buttonText || "Ver opciones").substring(0, 20),
      sections: validSections,
    },
  };

  if (headerText) {
    interactive.header = { type: "text", text: headerText.substring(0, 60) };
  }
  if (footerText) {
    interactive.footer = { text: footerText.substring(0, 60) };
  }

  return withTypingDelay(to, bodyText, () =>
    _sendPayload({
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive,
    })
  );
}

/**
 * Helper rápido para confirmación Sí/No.
 *
 * @param {string} to — Teléfono destino
 * @param {string} bodyText — Pregunta de confirmación
 */
async function sendQuickConfirmation(to, bodyText) {
  return sendInteractiveButtons(to, bodyText, [
    { id: "confirm_yes", title: "✅ Sí, confirmar" },
    { id: "confirm_no", title: "❌ No, cambiar" },
  ], null, "Aquí Pauli");
}

/**
 * Helper para selección de método de pago.
 */
async function sendPaymentMethodButtons(to, bodyText) {
  return sendInteractiveButtons(to, bodyText, [
    { id: "pay_sinpe", title: "📱 SINPE Móvil" },
    { id: "pay_transfer", title: "🏦 Transferencia" },
    { id: "pay_paypal", title: "💳 PayPal" },
  ], null, "Aquí Pauli");
}

// ========== MENSAJES DEL SISTEMA ==========

/**
 * Confirmación de pedido creado
 */
async function sendOrderConfirmation(phone, orderNumber, total) {
  const msg = `✅ *Pedido Confirmado*\n\n` +
    `📦 Orden: *${orderNumber}*\n` +
    `💰 Total: *₡${total.toLocaleString("es-CR")}*\n\n` +
    `Para completar tu compra, envía tu comprobante de SINPE o transferencia por este chat 📸\n\n` +
    `_Aquí Pauli — Tu tienda de confianza_`;

  return sendWhatsAppMessage(phone, msg);
}

/**
 * Acuse de recibo del comprobante
 */
async function sendPaymentReceived(phone, orderNumber) {
  const msg = `📸 *Comprobante Recibido*\n\n` +
    `Recibimos tu comprobante para la orden *${orderNumber}*.\n` +
    `Estamos verificando el pago. Te notificaremos cuando esté confirmado ✅\n\n` +
    `_Aquí Pauli_`;

  return sendWhatsAppMessage(phone, msg);
}

/**
 * Pago verificado
 */
async function sendPaymentVerified(phone, orderNumber) {
  const msg = `🎉 *Pago Verificado*\n\n` +
    `Tu pago para la orden *${orderNumber}* ha sido confirmado.\n` +
    `Estamos preparando tu pedido 📦\n\n` +
    `_Aquí Pauli_`;

  return sendWhatsAppMessage(phone, msg);
}

/**
 * Cambio de estado de la orden
 */
async function sendOrderStatusUpdate(phone, orderNumber, status) {
  const statusMessages = {
    pagado: "✅ Tu pago ha sido confirmado",
    por_preparar: "📋 Tu pedido está en cola de preparación",
    preparando: "🔧 Estamos preparando tu pedido",
    enviado: "🚚 Tu pedido ha sido enviado",
    entregado: "🏠 Tu pedido fue entregado. ¡Gracias por tu compra!",
    cancelado: "❌ Tu pedido fue cancelado",
  };

  const statusText = statusMessages[status] || `Estado actualizado: ${status}`;
  const msg = `📦 *Actualización de Pedido*\n\n` +
    `Orden: *${orderNumber}*\n` +
    `${statusText}\n\n` +
    `_Aquí Pauli_`;

  return sendWhatsAppMessage(phone, msg);
}

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppMessageImmediate,
  sendInteractiveButtons,
  sendInteractiveList,
  sendQuickConfirmation,
  sendPaymentMethodButtons,
  sendOrderConfirmation,
  sendPaymentReceived,
  sendPaymentVerified,
  sendOrderStatusUpdate,
};
