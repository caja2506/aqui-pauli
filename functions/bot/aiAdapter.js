// ==============================================
// AI ADAPTER — Adaptador de Gemini con salida estructurada
// Garantiza JSON válido, retry con fallback
// ==============================================

const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Schema de respuesta esperado de Gemini.
 * Se usa con responseSchema para forzar estructura.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: [
        "greeting", "product_inquiry", "price_check", "purchase",
        "order_status", "payment_info", "complaint", "clarification",
        "confirmation", "other",
      ],
    },
    replyText: { type: "string" },
    needsClarification: { type: "boolean" },
    clarificationQuestion: { type: "string" },
    detectedEntities: {
      type: "object",
      properties: {
        customerName: { type: "string" },
        selectedProduct: { type: "string" },
        selectedVariant: { type: "string" },
        quantity: { type: "integer" },
        address: { type: "string" },
        paymentMethod: { type: "string" },
      },
    },
    toolToCall: {
      type: "string",
      enum: [
        "none", "getProductCatalog", "getProductBySku", "checkStock",
        "getCustomerProfile", "saveCustomerAddress", "createOrUpdateCart",
        "createOrderDraft", "getOrderStatus", "handoffToHuman",
      ],
    },
    toolPayload: { type: "object" },
    shouldAdvanceStage: { type: "boolean" },
    nextStage: { type: "string" },
    confidence: { type: "number" },
    hallucinationRisk: { type: "string", enum: ["low", "medium", "high"] },
    internalReasoningSummary: { type: "string" },
  },
  required: ["intent", "replyText", "confidence", "hallucinationRisk"],
};

// ⚠️ REGLA INQUEBRANTABLE: NO cambiar este modelo. Definido por el dueño del negocio.
const GEMINI_MODEL = "gemini-2.5-flash";

/**
 * Llamar a Gemini con contexto estructurado
 *
 * @param {string} apiKey — API key de Gemini
 * @param {string} systemInstruction — instrucción del sistema
 * @param {string} contextPrompt — contexto construido por turno
 * @param {string} userMessage — mensaje del usuario
 * @returns {Object} — respuesta estructurada parseada
 */
async function callGemini(apiKey, systemInstruction, contextPrompt, userMessage) {
  if (!apiKey) {
    return _buildFallbackResponse("No hay API key configurada", "error");
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  // Intento 1: Con schema estricto
  try {
    const result = await _callWithSchema(genAI, systemInstruction, contextPrompt, userMessage);
    if (result) return result;
  } catch (err) {
    console.warn("[AI] Intento 1 (schema) falló:", err.message);
  }

  // Intento 2: Sin schema, solo responseMimeType JSON
  try {
    const result = await _callJsonMode(genAI, systemInstruction, contextPrompt, userMessage);
    if (result) return result;
  } catch (err) {
    console.warn("[AI] Intento 2 (JSON mode) falló:", err.message);
  }

  // Fallback: respuesta segura
  console.error("[AI] Todos los intentos fallaron. Usando fallback.");
  return _buildFallbackResponse("Error procesando con IA", "error");
}

/**
 * Intento 1: Con responseSchema (más restrictivo)
 */
async function _callWithSchema(genAI, systemInstruction, contextPrompt, userMessage) {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 3500,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const prompt = `${contextPrompt}\n\n[MENSAJE DEL CLIENTE]\n${userMessage}`;
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  return _parseResponse(text);
}

/**
 * Intento 2: Solo JSON mode (más flexible)
 */
async function _callJsonMode(genAI, systemInstruction, contextPrompt, userMessage) {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 3500,
      responseMimeType: "application/json",
    },
  });

  const prompt = `${contextPrompt}\n\n[MENSAJE DEL CLIENTE]\n${userMessage}`;
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  return _parseResponse(text);
}

/**
 * Parsear respuesta de Gemini a estructura esperada
 */
function _parseResponse(text) {
  if (!text) return null;

  let parsed;
  try {
    // Limpiar markdown si se cuela
    let clean = text;
    if (clean.startsWith("```")) {
      clean = clean.replace(/```json?\n?/g, "").replace(/```$/g, "").trim();
    }
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (jsonMatch) clean = jsonMatch[0];
    parsed = JSON.parse(clean);
  } catch {
    console.warn("[AI] JSON inválido:", text.substring(0, 200));
    // Intento de rescate: extraer replyText del JSON truncado con regex
    return _rescueFromTruncatedJson(text);
  }

  // Normalizar campos
  return {
    intent: parsed.intent || "other",
    replyText: parsed.replyText || parsed.reply || "",
    needsClarification: !!parsed.needsClarification,
    clarificationQuestion: parsed.clarificationQuestion || "",
    detectedEntities: _normalizeEntities(parsed.detectedEntities),
    toolToCall: parsed.toolToCall || "none",
    toolPayload: parsed.toolPayload || {},
    shouldAdvanceStage: !!parsed.shouldAdvanceStage,
    nextStage: parsed.nextStage || "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    hallucinationRisk: parsed.hallucinationRisk || "medium",
    internalReasoningSummary: parsed.internalReasoningSummary || "",
  };
}

/**
 * Rescatar datos de un JSON truncado.
 * Gemini a veces genera JSON válido pero lo corta antes de cerrarlo.
 * Extraemos lo que podamos con regex para no perder la respuesta.
 */
function _rescueFromTruncatedJson(text) {
  if (!text || text.length < 10) return null;

  // Extraer replyText — el campo más importante
  const replyMatch = text.match(/"replyText"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
  if (!replyMatch || !replyMatch[1] || replyMatch[1].length < 3) return null;

  const replyText = replyMatch[1]
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\/g, "");

  // Extraer intent
  const intentMatch = text.match(/"intent"\s*:\s*"([^"]+)"/);
  const intent = intentMatch ? intentMatch[1] : "other";

  // Extraer confidence
  const confMatch = text.match(/"confidence"\s*:\s*([\d.]+)/);
  const confidence = confMatch ? parseFloat(confMatch[1]) : 0.7;

  // Extraer toolToCall
  const toolMatch = text.match(/"toolToCall"\s*:\s*"([^"]+)"/);
  const toolToCall = toolMatch ? toolMatch[1] : "none";

  // Extraer nextStage
  const stageMatch = text.match(/"nextStage"\s*:\s*"([^"]+)"/);
  const nextStage = stageMatch ? stageMatch[1] : "";

  // Extraer shouldAdvanceStage
  const advanceMatch = text.match(/"shouldAdvanceStage"\s*:\s*(true|false)/);
  const shouldAdvanceStage = advanceMatch ? advanceMatch[1] === "true" : false;

  // Extraer selectedProduct de detectedEntities
  const productMatch = text.match(/"selectedProduct"\s*:\s*"([^"]+)"/);
  const selectedProduct = productMatch ? productMatch[1] : "";

  // Extraer selectedVariant
  const variantMatch = text.match(/"selectedVariant"\s*:\s*"([^"]+)"/);
  const selectedVariant = variantMatch ? variantMatch[1] : "";

  console.log(`[AI] JSON rescatado: intent=${intent}, replyText="${replyText.substring(0, 60)}...", confidence=${confidence}`);

  return {
    intent,
    replyText,
    needsClarification: false,
    clarificationQuestion: "",
    detectedEntities: _normalizeEntities({
      selectedProduct,
      selectedVariant,
    }),
    toolToCall,
    toolPayload: {},
    shouldAdvanceStage,
    nextStage,
    confidence,
    hallucinationRisk: "medium",
    internalReasoningSummary: "Rescued from truncated JSON",
    _isRescued: true,
  };
}
function _normalizeEntities(entities) {
  if (!entities || typeof entities !== "object") {
    return {
      customerName: "",
      selectedProduct: "",
      selectedVariant: "",
      quantity: 0,
      address: "",
      paymentMethod: "",
    };
  }

  return {
    customerName: entities.customerName || "",
    selectedProduct: entities.selectedProduct || "",
    selectedVariant: entities.selectedVariant || "",
    quantity: parseInt(entities.quantity) || 0,
    address: entities.address || "",
    paymentMethod: entities.paymentMethod || "",
  };
}

/**
 * Respuesta fallback segura
 */
function _buildFallbackResponse(reason, intent) {
  return {
    intent: intent || "other",
    replyText: "¡Hola! 😊 Disculpá, tuve un problemita. ¿Me podés repetir qué necesitás?",
    needsClarification: true,
    clarificationQuestion: "",
    detectedEntities: _normalizeEntities(null),
    toolToCall: "none",
    toolPayload: {},
    shouldAdvanceStage: false,
    nextStage: "",
    confidence: 0,
    hallucinationRisk: "high",
    internalReasoningSummary: `Fallback: ${reason}`,
    _isFallback: true,
  };
}

/**
 * Obtener instancia de GoogleGenerativeAI para uso externo (e.g. summaryManager)
 */
function getGenAIInstance(apiKey) {
  return new GoogleGenerativeAI(apiKey);
}

module.exports = {
  callGemini,
  getGenAIInstance,
  GEMINI_MODEL,
  RESPONSE_SCHEMA,
};
