// ==============================================
// CONVERSATION.JS — Punto de entrada conversacional
// REFACTORIZADO: Delega al nuevo orquestador modular (bot/orchestrator.js)
// Mantiene exports compatibles con messaging.js y whatsapp/webhook.js
// ==============================================

const { defineSecret } = require("firebase-functions/params");
const { db } = require("./utils");

const geminiApiKey = defineSecret("GEMINI_API_KEY");

// ========== NUEVO ORQUESTADOR ==========
const orchestrator = require("./bot/orchestrator");

// ========== FUNCIONES LEGACY REUTILIZADAS ==========
const { getProductCatalog } = require("./bot/toolExecutor");

/**
 * Procesar mensaje entrante — DELEGA al nuevo orquestador
 * Mantiene la misma firma para compatibilidad con:
 *   - messaging.js:195 (whatsappWebhook)
 *   - messaging.js:407 (telegramWebhook)
 *   - whatsapp/webhook.js:272 (processTextMessage)
 */
async function processInboundMessage(messageText, contact, { phone, contactId, channel } = {}) {
  return orchestrator.processInboundMessage(messageText, contact, {
    phone,
    contactId,
    channel: channel || "whatsapp",
  });
}

/**
 * Obtener contexto del catálogo — compatibilidad
 * Usado por código legacy que importa getCatalogContext
 */
async function getCatalogContext() {
  const result = await getProductCatalog({ limit: 20 });
  return result.success ? result.data.formatted : "No hay productos disponibles.";
}

/**
 * Obtener contexto del contacto — compatibilidad
 * Usado por código legacy que importa getContactContext
 */
function getContactContext(contact) {
  if (!contact) return "Cliente nuevo, no se tiene info previa.";
  const parts = [];
  if (contact.displayName) parts.push(`Nombre: ${contact.displayName}`);
  if (contact.cedula) parts.push(`Cédula: ${contact.cedula}`);
  if (contact.email) parts.push(`Email: ${contact.email}`);
  if (contact.phone) parts.push(`Teléfono: ${contact.phone}`);
  if (contact.totalOrders > 0) parts.push(`Pedidos anteriores: ${contact.totalOrders}`);
  if (contact.funnelStage) parts.push(`Etapa: ${contact.funnelStage}`);
  if (contact.lastAddress) {
    const addr = contact.lastAddress;
    const addrParts = [addr.provincia, addr.canton, addr.distrito].filter(Boolean);
    if (addrParts.length > 0) parts.push(`Dirección guardada: ${addrParts.join(", ")}`);
    if (addr.señas) parts.push(`Señas: ${addr.señas}`);
  }
  if (contact.preferredPaymentMethod) parts.push(`Método de pago preferido: ${contact.preferredPaymentMethod}`);
  return parts.length > 0 ? parts.join(", ") : "Sin historial.";
}

// Mantener la función processWithGemini para compatibilidad
// pero ahora es un wrapper que genera un warning
async function processWithGemini(messageText, contact, catalogInfo, orderInfo, conversationHistory) {
  console.warn("[DEPRECATED] processWithGemini llamada directamente. Usar processInboundMessage en su lugar.");
  return processInboundMessage(messageText, contact, {});
}

module.exports = {
  processInboundMessage,
  processWithGemini,
  getCatalogContext,
  getContactContext,
  geminiApiKey,
};
