// ==============================================
// SUMMARY MANAGER — Resumen acumulado de conversación
// Actualiza cada N turnos o al cambiar info importante
// ==============================================

const { db } = require("../utils");
const { SESSIONS_COLLECTION } = require("./sessionManager");

// Cada cuántos turnos actualizar el resumen
const SUMMARY_UPDATE_INTERVAL = 3;

/**
 * Decidir si hay que actualizar el resumen
 */
function shouldUpdateSummary(turnCount, aiResponse) {
  // Cada N turnos
  if (turnCount > 0 && turnCount % SUMMARY_UPDATE_INTERVAL === 0) return true;

  // Si se detectaron nuevas entidades importantes
  if (aiResponse?.detectedEntities) {
    const entities = aiResponse.detectedEntities;
    if (entities.selectedProduct || entities.address || entities.customerName) return true;
  }

  // Si avanza de etapa
  if (aiResponse?.shouldAdvanceStage) return true;

  return false;
}

/**
 * Generar resumen actualizado de la conversación
 * Usa Gemini con prompt específico de resumen
 *
 * @param {Object} genAI — instancia de GoogleGenerativeAI
 * @param {string} modelName — nombre del modelo a usar
 * @param {string} currentSummary — resumen actual
 * @param {string} userMessage — último mensaje del usuario
 * @param {string} botReply — última respuesta del bot
 * @param {Object} entities — entidades extraídas
 * @returns {string} — resumen actualizado
 */
async function generateUpdatedSummary(genAI, modelName, currentSummary, userMessage, botReply, entities) {
  try {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 300,
      },
    });

    const entityStr = Object.entries(entities || {})
      .filter(([, v]) => v && v !== "" && v !== 0)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");

    const prompt = `Sos un asistente que resume conversaciones de venta por WhatsApp.

RESUMEN ACTUAL:
${currentSummary || "(conversación nueva)"}

NUEVO INTERCAMBIO:
Cliente: ${userMessage}
Bot: ${botReply}
${entityStr ? `Datos capturados: ${entityStr}` : ""}

INSTRUCCIONES:
- Actualizá el resumen incorporando la información nueva
- Máximo 3-4 oraciones
- Incluí: qué quiere el cliente, qué productos preguntó, qué datos se capturaron, en qué etapa está
- NO incluyas saludos ni fórmulas de cortesía
- Escribí en español, tercera persona

RESUMEN ACTUALIZADO:`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Validar que no esté vacío o sea basura
    if (!text || text.length < 10) return currentSummary || "";

    return text.substring(0, 500); // Limitar largo
  } catch (err) {
    console.error("[Summary] Error generando resumen:", err.message);
    // Fallback: resumen manual simple
    return _fallbackSummary(currentSummary, userMessage, botReply, entities);
  }
}

/**
 * Fallback si Gemini no puede generar resumen
 */
function _fallbackSummary(currentSummary, userMessage, botReply, entities) {
  const parts = [];
  if (currentSummary) parts.push(currentSummary);

  const entityStr = Object.entries(entities || {})
    .filter(([, v]) => v && v !== "" && v !== 0)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  if (entityStr) {
    parts.push(`Datos capturados: ${entityStr}.`);
  }

  parts.push(`Último intercambio: cliente dijo "${userMessage.substring(0, 80)}", bot respondió sobre ${botReply.substring(0, 60)}.`);

  return parts.join(" ").substring(0, 500);
}

/**
 * Persistir el resumen en la sesión
 */
async function saveSummary(sessionId, summary) {
  if (!sessionId || sessionId.startsWith("temp_")) return;

  try {
    await db.collection(SESSIONS_COLLECTION).doc(sessionId).update({
      runningSummary: summary,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Summary] Error guardando resumen:", err.message);
  }
}

module.exports = {
  shouldUpdateSummary,
  generateUpdatedSummary,
  saveSummary,
  SUMMARY_UPDATE_INTERVAL,
};
