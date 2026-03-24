// ==============================================
// CONTEXT BUILDER — Construye el contexto por turno
// NO manda historial crudo. Usa resumen + estado.
// ==============================================

const {
  getStagePrompt,
  getStagesForPrompt,
  getAllowedTools,
} = require("./stateMachine");
const { getRulesForPrompt } = require("./businessRules");

/**
 * Construye el contexto completo para enviar a Gemini.
 * Bloques separados y controlados.
 *
 * @param {Object} session — sesión actual del bot
 * @param {string} userMessage — mensaje del usuario
 * @param {Object} contact — datos CRM del contacto
 * @param {string} catalogData — catálogo relevante (ya filtrado)
 * @param {string} orderData — info de órdenes del cliente
 * @param {Array} chatHistory — últimos 15 mensajes de la conversación
 * @returns {Object} — { systemInstruction, contextPrompt }
 */
async function buildConversationContext(
  session,
  userMessage,
  contact,
  catalogData,
  orderData,
  chatHistory,
) {
  const stage = session.currentStage || "greeting";
  const entities = session.extractedEntities || {};
  const summary = session.runningSummary || "";
  const turnCount = session.turnCount || 0;

  // ========== SYSTEM INSTRUCTION (fija) ==========
  const systemInstruction = await buildSystemInstruction(stage);

  // ========== CONTEXT PROMPT (dinámico por turno) ==========
  const contextBlocks = [];

  // Bloque 1: Estado actual de la sesión
  contextBlocks.push(buildSessionBlock(stage, turnCount, entities));

  // Bloque 2: Resumen acumulado (si existe)
  if (summary) {
    contextBlocks.push(`[RESUMEN DE CONVERSACIÓN]\n${summary}`);
  }

  // Bloque 3: Perfil del cliente
  contextBlocks.push(buildContactBlock(contact));

  // Bloque 4: Hechos de negocio (catálogo, órdenes)
  // En greeting/discovery no inyectar catálogo completo para evitar que Gemini lo liste como texto
  const skipFullCatalog = stage === "greeting" || (stage === "discovery" && !entities.selectedProduct);
  if (catalogData && catalogData !== "No hay productos disponibles." && !skipFullCatalog) {
    contextBlocks.push(`[CATÁLOGO DISPONIBLE]\n${catalogData}`);
  }
  if (orderData) {
    contextBlocks.push(`[ÓRDENES DEL CLIENTE]\n${orderData}`);
  }

  // Bloque 5: Historial de conversación (últimos 15 mensajes)
  if (chatHistory && chatHistory.length > 0) {
    const historyLines = chatHistory.map(m => {
      const who = m.direction === "inbound" ? "👤 Cliente" : "🤖 Bot";
      return `${who}: ${m.content}`;
    });
    contextBlocks.push(`[HISTORIAL DE CONVERSACIÓN (Últimos ${chatHistory.length} mensajes)]\n${historyLines.join("\n")}`);
  } else if (session.lastBotReply) {
    // Fallback si no hay historial cargado
    contextBlocks.push(`[ÚLTIMO MENSAJE DEL BOT]\n${session.lastBotReply}`);
  }

  // Bloque 6: Herramientas disponibles
  const tools = getAllowedTools(stage);
  if (tools.length > 0) {
    contextBlocks.push(buildToolsBlock(tools));
  }

  // Bloque 7: Preguntas recientes (anti-repetición)
  if (session.recentQuestions && session.recentQuestions.length > 0) {
    const questionLines = session.recentQuestions.map((q, i) => {
      const answered = q.answered ? `(ya respondida: ${q.answer})` : "(pendiente)";
      return `${i + 1}. "${q.question}" ${answered}`;
    });
    contextBlocks.push(`[PREGUNTAS RECIENTES — NO REPETIR]\n${questionLines.join("\n")}\nIMPORTANTE: NO repitas estas preguntas. Si ya fueron respondidas, usá la info. Si están pendientes, reformulá de otra manera.`);
  }

  // Bloque 8: Instrucciones de etapa
  contextBlocks.push(`[INSTRUCCIÓN DE ETAPA ACTUAL]\n${getStagePrompt(stage)}`);

  const contextPrompt = contextBlocks.join("\n\n");

  return { systemInstruction, contextPrompt };
}

/**
 * System instruction fija (personalidad, reglas, formato)
 */
async function buildSystemInstruction(currentStage) {
  // Cargar reglas de negocio desde Firestore (con cache 5min)
  const businessRulesBlock = await getRulesForPrompt();

  return `[ROL]
Sos Paulina, vendedora de Aquí Pauli — tienda online de ropa, calzado y accesorios en Costa Rica.

[PERSONALIDAD]
- Hablás en FEMENINO, usás "vos" (nunca "usted" ni "tú")
- Español neutro y amigable, sin modismos regionales
- 1-2 emojis por mensaje (máximo 3)
- Tono: WhatsApp natural, cálido y profesional

[OBJETIVO]
Tu misión es VENDER. Guiá al cliente paso a paso hasta completar la compra.
Estás actualmente en la etapa: ${currentStage}

[ETAPAS DISPONIBLES]
${getStagesForPrompt()}

${businessRulesBlock}

[REGLAS CRÍTICAS ADICIONALES]
- SOLO usá precios del catálogo proporcionado. NUNCA inventes precios.
- NUNCA inventes números de pedido, stock, tiempos de entrega, ni promociones.
- Cuando crees un pedido con createOrderDraft, SIEMPRE compartí el número de orden con el cliente.
- Si no tenés un dato, preguntá o usá la tool correspondiente.
- Si el cliente ya confirmó un dato, NUNCA lo pidas de nuevo.

[REGLA DE CATÁLOGO — MUY IMPORTANTE]
- NUNCA listes productos como texto plano en tu respuesta (ej: "Opción 1: Producto X ₡5,000").
- En su lugar, invitá al cliente a explorar el catálogo. El sistema automáticamente agrega un botón de "Ver Catálogo 📋" para el cliente.
- SOLO mencioná un producto específico si el cliente YA preguntó por él o si encontrás uno relevante con una tool.
- Está PROHIBIDO enumerar productos con precios en el texto del mensaje.

[ANTI-ALUCINACIÓN — REGLAS ESTRICTAS]
- SOLO podés mencionar productos que aparecen en [CATÁLOGO DISPONIBLE] o en el resultado de getProductCatalog/getProductBySku.
- NUNCA inventes categorías, subcategorías, líneas de producto, colecciones ni nombres de producto.
- Si el cliente pregunta por algo que NO está en el catálogo, respondé: "No tenemos ese producto en este momento, pero te puedo mostrar lo que sí tenemos."
- Si no tenés datos del catálogo todavía, usá getProductCatalog primero ANTES de mencionar cualquier producto.
- En "internalReasoningSummary" SIEMPRE verificá: "¿Los productos/categorías que menciono están en los datos reales?"

[REGLAS DE FLUJO]
- Si el cliente dice "sí"/ "ok"/ "listo"/ "correcto"/ "Me parece bien"/ "Yes"/"dale"/"va"/"perfecto": es o cualquier frase afirmativa CONFIRMACIÓN de lo último que preguntaste. NO resetees.
- Si el cliente cambia de tema: respondé brevemente y retomá el flujo de venta.
- SIEMPRE avanzá a la siguiente etapa cuando tengas los datos necesarios.
- Si ya tenés datos suficientes, SALTATE etapas intermedias.
- Si el cliente ya respondió algo (lo ves en DATOS RECOPILADOS), NO lo pidas de nuevo. NUNCA repitas una pregunta ya respondida.
- Si la respuesta del cliente no es clara, reformulá la pregunta de forma diferente en vez de repetir la misma.
- NOTA: Los botones interactivos los genera el sistema automáticamente. NO necesitás sugerirlos.

[FORMATO DE SALIDA]
Respondé SIEMPRE con este JSON exacto y NADA más:
{
  "intent": "greeting | product_inquiry | price_check | purchase | order_status | payment_info | complaint | clarification | confirmation | other",
  "replyText": "tu mensaje para el cliente (SOLO texto natural para WhatsApp)",
  "needsClarification": false,
  "clarificationQuestion": "",
  "detectedEntities": {
    "customerName": "",
    "selectedProduct": "",
    "selectedVariant": "",
    "quantity": 0,
    "address": "",
    "paymentMethod": ""
  },
  "toolToCall": "none | getProductCatalog | getProductBySku | checkStock | getCustomerProfile | saveCustomerAddress | createOrUpdateCart | createOrderDraft | getOrderStatus | handoffToHuman",
  "toolPayload": {},
  "shouldAdvanceStage": false,
  "nextStage": "",
  "confidence": 0.0,
  "hallucinationRisk": "low",
  "internalReasoningSummary": "Verifico: los productos que menciono están en el catálogo? [razonamiento]"
}

[PROHIBICIONES EN replyText]
El campo "replyText" SOLO contiene el mensaje para el cliente. PROHIBIDO incluir:
- Análisis, razonamiento, o meta-comentarios
- Frases como "El usuario dijo", "Estamos en ETAPA", "Mi objetivo es"
- JSON, código, o texto técnico
- Datos inventados que no están en el catálogo o en los datos proporcionados`;
}

/**
 * Bloque de estado de sesión
 */
function buildSessionBlock(stage, turnCount, entities) {
  const entityLines = [];
  if (entities.customerName)
    entityLines.push(`Nombre: ${entities.customerName}`);
  if (entities.selectedProduct)
    entityLines.push(`Producto seleccionado: ${entities.selectedProduct}`);
  if (entities.selectedVariant)
    entityLines.push(`Variante: ${entities.selectedVariant}`);
  if (entities.quantity > 0) entityLines.push(`Cantidad: ${entities.quantity}`);
  if (entities.address) entityLines.push(`Dirección: ${entities.address}`);
  if (entities.paymentMethod)
    entityLines.push(`Método de pago: ${entities.paymentMethod}`);
  if (entities.orderNumber)
    entityLines.push(`Número de orden: ${entities.orderNumber}`);

  return `[ESTADO DE SESIÓN]
Etapa actual: ${stage}
Turno: ${turnCount + 1}
${entityLines.length > 0 ? "Datos recopilados:\n" + entityLines.join("\n") : "Sin datos recopilados aún."}`;
}

/**
 * Bloque de perfil del contacto
 */
function buildContactBlock(contact) {
  if (!contact)
    return "[PERFIL DEL CLIENTE]\nCliente nuevo, sin información previa.";

  const parts = [];
  if (contact.displayName) parts.push(`Nombre: ${contact.displayName}`);
  if (contact.phone) parts.push(`Teléfono: ${contact.phone}`);
  if (contact.totalOrders > 0)
    parts.push(`Pedidos anteriores: ${contact.totalOrders}`);
  if (contact.funnelStage) parts.push(`Tipo: ${contact.funnelStage}`);

  // Dirección guardada
  if (contact.lastAddress) {
    const addr = contact.lastAddress;
    const addrParts = [addr.provincia, addr.canton, addr.distrito].filter(
      Boolean,
    );
    if (addrParts.length > 0)
      parts.push(`Dirección guardada: ${addrParts.join(", ")}`);
    if (addr.señas) parts.push(`Señas: ${addr.señas}`);
  }
  if (contact.preferredPaymentMethod)
    parts.push(`Pago preferido: ${contact.preferredPaymentMethod}`);

  return `[PERFIL DEL CLIENTE]\n${parts.length > 0 ? parts.join("\n") : "Sin historial."}`;
}

/**
 * Bloque de herramientas disponibles
 */
function buildToolsBlock(tools) {
  const descriptions = {
    getProductCatalog:
      "Buscar productos en el catálogo (opcionalmente filtrados por búsqueda)",
    getProductBySku:
      "Obtener detalles de un producto específico con sus variantes",
    checkStock: "Verificar disponibilidad/stock de un producto o variante",
    getCustomerProfile: "Obtener perfil completo del cliente desde el CRM",
    saveCustomerAddress: "Guardar la dirección del cliente",
    createOrUpdateCart: "Crear o actualizar el carrito del cliente",
    createOrderDraft: "Crear el pedido cuando el cliente confirma",
    getOrderStatus: "Consultar el estado de una orden existente",
    handoffToHuman: "Escalar la conversación a un humano",
  };

  const lines = tools.map((t) => `- ${t}: ${descriptions[t] || t}`);
  return `[HERRAMIENTAS DISPONIBLES]
Si necesitás consultar el backend, indicalo en "toolToCall" con el payload en "toolPayload".
${lines.join("\n")}`;
}

module.exports = {
  buildConversationContext,
  buildSystemInstruction,
};
