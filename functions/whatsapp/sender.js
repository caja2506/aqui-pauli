// ==============================================
// WhatsApp Business API — Sender
// Envía mensajes al cliente via WhatsApp
// ==============================================
const { defineSecret } = require("firebase-functions/params");
const fetch = require("node-fetch");

const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");
const WHATSAPP_PHONE_ID = defineSecret("WHATSAPP_PHONE_ID");

/**
 * Envía un mensaje de texto simple por WhatsApp
 */
async function sendWhatsAppMessage(to, text) {
  const phone = to.startsWith("506") ? to : "506" + to.replace(/\D/g, "");
  const url = `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID.value()}/messages`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN.value().replace(/^Bearer\s+/i, '').trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await resp.json();
  if (data.error) {
    console.error("❌ WhatsApp send error:", data.error);
    throw new Error(data.error.message);
  }
  return data;
}

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
  sendOrderConfirmation,
  sendPaymentReceived,
  sendPaymentVerified,
  sendOrderStatusUpdate,
};
