// ==============================================
// RESPONSE FORMATTER — Formateo final de respuestas
// Combina IA + resultados de tools + templates del sistema
// ==============================================

/**
 * Formatear la respuesta final que se envía al usuario
 *
 * @param {Object} aiResponse — respuesta validada de Gemini
 * @param {Object} toolResult — resultado de la tool ejecutada (si aplica)
 * @param {Object} session — sesión actual
 * @returns {string} — mensaje final para el usuario
 */
function formatReply(aiResponse, toolResult, session) {
  // Si hay resultado de tool que genera mensaje del sistema, usarlo
  if (toolResult && toolResult.success) {
    const systemMessage = formatToolResult(aiResponse.toolToCall, toolResult, session);
    if (systemMessage) return systemMessage;
  }

  // Si la tool falló, informar al usuario
  if (toolResult && !toolResult.success) {
    return formatToolError(aiResponse.toolToCall, toolResult.error, session);
  }

  // Si necesita aclaración, usar la pregunta de aclaración
  if (aiResponse.needsClarification && aiResponse.clarificationQuestion) {
    return aiResponse.clarificationQuestion;
  }

  // Respuesta normal de IA
  return aiResponse.replyText;
}

/**
 * Formatear resultado de una tool en mensaje para el usuario
 */
function formatToolResult(toolName, toolResult, session) {
  const data = toolResult.data;
  if (!data) return null;

  switch (toolName) {
    case "createOrderDraft":
      return _formatOrderCreated(data, session);
    case "getOrderStatus":
      return _formatOrderStatus(data);
    case "handoffToHuman":
      return "Te voy a conectar con alguien del equipo que te puede ayudar mejor. ¡Ya te contactan! 🙏";
    default:
      return null; // Las demás tools no generan mensaje del sistema directo
  }
}

/**
 * Formatear orden creada (mensaje del SISTEMA, no del modelo)
 */
function _formatOrderCreated(data, session) {
  const itemsList = (data.items || [])
    .map(i => {
      const badge = i.supplyType === "bajo_pedido" ? " ⏳(bajo pedido)" : "";
      return `• ${i.productName} x${i.quantity} — ₡${(i.price || 0).toLocaleString()}${badge}`;
    })
    .join("\n");

  const address = session.extractedEntities?.address || "No especificada";

  let reply = `✅ *¡Pedido confirmado!*\n\n` +
    `🔖 *Número de pedido:* ${data.orderNumber}\n\n` +
    `📦 *Productos:*\n${itemsList}\n\n` +
    `📍 *Envío a:* ${address}\n` +
    `🚚 *Envío:* ₡${(data.shippingCost || 0).toLocaleString()}\n` +
    `💰 *Subtotal:* ₡${(data.subtotal || 0).toLocaleString()}\n` +
    `💰 *Total:* ₡${(data.total || 0).toLocaleString()}\n`;

  // Desglose bajo pedido (anticipo 20%)
  if (data.hasBackorder && data.backorderDeposit > 0) {
    reply += `\n⏳ *Este pedido incluye productos bajo pedido*\n` +
      `💵 *Anticipo (${data.backorderDepositPercent || 20}%):* ₡${data.backorderDeposit.toLocaleString()}\n` +
      `💵 *Saldo al recibir:* ₡${(data.remainingTotal || 0).toLocaleString()}\n` +
      `📅 *Entrega estimada:* 15-20 días hábiles\n`;
  }

  reply += `\n💳 *Pago:* SINPE Móvil / Transferencia\n` +
    `📱 *SINPE:* 7095-6070\n` +
    `🏦 *IBAN:* CR15081400011020004961\n\n`;

  if (data.hasBackorder && data.backorderDeposit > 0) {
    reply += `Enviame el comprobante del anticipo de ₡${data.backorderDeposit.toLocaleString()} cuando lo hagás 😊🎉`;
  } else {
    reply += `Enviame el comprobante cuando lo hagás 😊🎉`;
  }

  return reply;
}

/**
 * Formatear estado de orden
 */
function _formatOrderStatus(data) {
  const itemsList = (data.items || [])
    .map(i => `• ${i.productName} x${i.quantity}`)
    .join("\n");

  let reply = `📋 *Pedido ${data.orderNumber}*\n\n` +
    `📊 *Estado:* ${data.status}\n` +
    `💰 *Total:* ₡${(data.total || 0).toLocaleString()}\n`;

  if (itemsList) {
    reply += `📦 *Productos:*\n${itemsList}\n`;
  }

  if (data.trackingNumber) {
    reply += `🚚 *Tracking:* ${data.trackingNumber}\n`;
  }

  reply += `\n¿Necesitás algo más? 😊`;
  return reply;
}

/**
 * Formatear error de tool
 */
function formatToolError(toolName, error, session) {
  const messages = {
    createOrderDraft: `No pude crear el pedido: ${error}. ¿Podés confirmarme los datos? 😊`,
    getProductBySku: "No encontré ese producto en nuestro catálogo. ¿Me podés dar más detalles? 😊",
    checkStock: "No pude verificar la disponibilidad ahora. ¿Me podés repetir qué producto buscás? 😊",
    getOrderStatus: `No encontré esa orden. ¿Tenés el número de pedido (AP-XXXXXX)? 😊`,
    handoffToHuman: "Tuve un problemita pero te voy a conectar con el equipo. 🙏",
  };

  return messages[toolName] || `Tuve un problemita consultando eso. ¿Me podés repetir? 😊`;
}

/**
 * Formatear resumen de pedido para confirmación (antes de crear)
 */
function formatOrderSummary(items, address, shippingCost = 2500) {
  const itemsList = items
    .map(i => `• ${i.productName} x${i.quantity || 1} — ₡${(i.price || 0).toLocaleString()}`)
    .join("\n");

  const subtotal = items.reduce((sum, i) => sum + (i.price || 0) * (i.quantity || 1), 0);
  const total = subtotal + shippingCost;

  return `📋 *Resumen de tu pedido:*\n\n` +
    `📦 *Productos:*\n${itemsList}\n\n` +
    `📍 *Envío a:* ${address || "Por confirmar"}\n` +
    `🚚 *Envío:* ₡${shippingCost.toLocaleString()}\n` +
    `💰 *Total:* ₡${total.toLocaleString()}\n\n` +
    `💳 *Pago:* SINPE 7095-6070 / IBAN CR15081400011020004961\n\n` +
    `¿Todo correcto? ¿Procedo? 😊`;
}

module.exports = {
  formatReply,
  formatToolResult,
  formatToolError,
  formatOrderSummary,
};
