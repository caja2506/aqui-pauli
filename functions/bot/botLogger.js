// ==============================================
// BOT LOGGER — Logging y trazabilidad por turno
// Colección: bot_logs
// ==============================================

const { db } = require("../utils");

const LOGS_COLLECTION = "bot_logs";

/**
 * Registrar un turno completo de conversación
 *
 * @param {Object} params
 * @param {string} params.sessionId — ID de la sesión
 * @param {number} params.turnNumber — número de turno
 * @param {string} params.userInput — mensaje del usuario
 * @param {string} params.contextSent — resumen del contexto enviado a Gemini
 * @param {string} params.summarySent — resumen acumulado usado
 * @param {Object} params.sessionStateBefore — estado antes del turno
 * @param {Object} params.sessionStateAfter — estado después del turno
 * @param {Array} params.toolsCalled — [{ name, payload, result }]
 * @param {Object} params.geminiRawResponse — respuesta cruda de Gemini
 * @param {string} params.finalReply — mensaje final enviado al usuario
 * @param {number} params.responseTimeMs — tiempo de respuesta en ms
 * @param {Array} params.errors — errores encontrados
 * @param {Array} params.guardrailIssues — issues detectados por guardrails
 */
async function logTurn({
  sessionId,
  turnNumber,
  userInput,
  contextSent,
  summarySent,
  sessionStateBefore,
  sessionStateAfter,
  toolsCalled,
  geminiRawResponse,
  finalReply,
  responseTimeMs,
  errors,
  guardrailIssues,
}) {
  try {
    await db.collection(LOGS_COLLECTION).add({
      sessionId: sessionId || "",
      turnNumber: turnNumber || 0,
      userInput: (userInput || "").substring(0, 1000),
      contextSent: (contextSent || "").substring(0, 500),
      summarySent: (summarySent || "").substring(0, 500),
      sessionStateBefore: _sanitizeState(sessionStateBefore),
      sessionStateAfter: _sanitizeState(sessionStateAfter),
      toolsCalled: (toolsCalled || []).map(t => ({
        name: t.name || "",
        payload: JSON.stringify(t.payload || {}).substring(0, 300),
        success: t.result?.success || false,
        resultSummary: JSON.stringify(t.result?.data || t.result?.error || {}).substring(0, 300),
      })),
      geminiResponse: _sanitizeGeminiResponse(geminiRawResponse),
      finalReply: (finalReply || "").substring(0, 1000),
      responseTimeMs: responseTimeMs || 0,
      errors: errors || [],
      guardrailIssues: guardrailIssues || [],
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // El logger NUNCA debe romper el flujo principal
    console.error("[BotLogger] Error guardando log:", err.message);
  }
}

/**
 * Sanitizar estado de sesión para log (quitar datos sensibles, limitar tamaño)
 */
function _sanitizeState(state) {
  if (!state) return {};
  return {
    currentStage: state.currentStage || "",
    turnCount: state.turnCount || 0,
    confidenceScore: state.confidenceScore || 0,
    lowConfidenceStreak: state.lowConfidenceStreak || 0,
    lastUserIntent: state.lastUserIntent || "",
    extractedEntities: state.extractedEntities || {},
    escalationFlag: state.escalationFlag || false,
  };
}

/**
 * Sanitizar respuesta de Gemini para log
 */
function _sanitizeGeminiResponse(response) {
  if (!response) return {};
  return {
    intent: response.intent || "",
    replyText: (response.replyText || "").substring(0, 500),
    confidence: response.confidence || 0,
    hallucinationRisk: response.hallucinationRisk || "",
    toolToCall: response.toolToCall || "none",
    shouldAdvanceStage: response.shouldAdvanceStage || false,
    nextStage: response.nextStage || "",
    needsClarification: response.needsClarification || false,
    internalReasoning: (response.internalReasoningSummary || "").substring(0, 300),
    _isFallback: response._isFallback || false,
  };
}

/**
 * Log rápido de error (sin turno completo)
 */
async function logError(sessionId, error, context) {
  try {
    await db.collection(LOGS_COLLECTION).add({
      sessionId: sessionId || "",
      type: "error",
      error: typeof error === "string" ? error : error.message || "Error desconocido",
      stack: error?.stack?.substring(0, 500) || "",
      context: (context || "").substring(0, 300),
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[BotLogger] Error guardando error log:", err.message);
  }
}

module.exports = {
  logTurn,
  logError,
  LOGS_COLLECTION,
};
