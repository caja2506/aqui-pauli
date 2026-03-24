// ==============================================
// SESSION MANAGER — Persistencia de sesión conversacional
// Colección: bot_sessions
// ==============================================

const { db } = require("../utils");
const { getInitialStage, canTransition } = require("./stateMachine");

const SESSIONS_COLLECTION = "bot_sessions";

// Tiempo máximo de inactividad antes de resetear sesión (2 horas)
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Genera un ID de sesión determinista basado en teléfono y canal.
 * Esto evita queries compuestas que requieren índices.
 */
function _buildSessionId(phoneOrChatId, channel) {
  // Limpiar phone para usarlo como doc ID (solo alfanuméricos)
  const cleanId = (phoneOrChatId || "unknown").replace(/[^a-zA-Z0-9]/g, "");
  return `${cleanId}_${channel || "whatsapp"}`;
}

/**
 * Obtener o crear sesión para un teléfono/chatId.
 * Usa document ID determinista (phone_channel) → NO necesita índice compuesto.
 *
 * @param {string} phoneOrChatId — identificador del usuario
 * @param {string} channel — "whatsapp" | "telegram"
 * @param {string} contactId — ID del contacto CRM
 * @returns {Object} — { session, isNew }
 */
async function getOrCreateSession(phoneOrChatId, channel, contactId) {
  const sessionId = _buildSessionId(phoneOrChatId, channel);

  try {
    const ref = db.collection(SESSIONS_COLLECTION).doc(sessionId);
    const snap = await ref.get();

    if (snap.exists) {
      const session = { id: snap.id, ...snap.data() };

      // Verificar si la sesión expiró
      const lastUpdate = new Date(session.updatedAt).getTime();
      const now = Date.now();
      if (now - lastUpdate > SESSION_TIMEOUT_MS) {
        console.log(`[Session] Sesión expirada para ${phoneOrChatId}, reseteando`);
        return { session: await _createSession(sessionId, phoneOrChatId, channel, contactId, false), isNew: true };
      }

      // Actualizar contactId si cambió
      if (contactId && session.contactId !== contactId) {
        await ref.update({ contactId, updatedAt: new Date().toISOString() });
        session.contactId = contactId;
      }

      return { session, isNew: false };
    }

    // No existe — crear nueva
    return { session: await _createSession(sessionId, phoneOrChatId, channel, contactId, true), isNew: true };
  } catch (err) {
    console.error("[Session] Error getOrCreateSession:", err.message);
    // Retornar sesión en memoria como fallback
    return {
      session: _buildDefaultSession(phoneOrChatId, channel, contactId),
      isNew: true,
    };
  }
}

/**
 * Crear nueva sesión en Firestore con ID determinista
 */
async function _createSession(sessionId, phoneOrChatId, channel, contactId, isFirstContact) {
  const now = new Date().toISOString();
  const sessionData = {
    phoneNumber: phoneOrChatId,
    channel,
    contactId: contactId || "",
    currentStage: getInitialStage(!isFirstContact),
    runningSummary: "",
    extractedEntities: {
      customerName: "",
      selectedProduct: "",
      selectedProductId: "",
      selectedVariant: "",
      selectedVariantId: "",
      quantity: 0,
      address: "",
      paymentMethod: "",
      orderNumber: "",
    },
    cartSnapshot: { items: [] },
    recentQuestions: [],
    lastBotAction: "",
    lastBotReply: "",
    lastUserIntent: "",
    lastUserMessage: "",
    escalationFlag: false,
    confidenceScore: 0,
    turnCount: 0,
    lowConfidenceStreak: 0,
    createdAt: now,
    updatedAt: now,
  };

  const ref = db.collection(SESSIONS_COLLECTION).doc(sessionId);
  await ref.set(sessionData);

  return { id: sessionId, ...sessionData };
}

/**
 * Construir sesión por defecto (fallback en memoria si Firestore falla)
 */
function _buildDefaultSession(phoneOrChatId, channel, contactId) {
  return {
    id: `temp_${Date.now()}`,
    phoneNumber: phoneOrChatId,
    channel,
    contactId: contactId || "",
    currentStage: "greeting",
    runningSummary: "",
    extractedEntities: {
      customerName: "",
      selectedProduct: "",
      selectedProductId: "",
      selectedVariant: "",
      selectedVariantId: "",
      quantity: 0,
      address: "",
      paymentMethod: "",
      orderNumber: "",
    },
    cartSnapshot: { items: [] },
    lastBotAction: "",
    lastBotReply: "",
    lastUserIntent: "",
    lastUserMessage: "",
    escalationFlag: false,
    confidenceScore: 0,
    turnCount: 0,
    lowConfidenceStreak: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Actualizar sesión con datos parciales
 */
async function updateSession(sessionId, updates) {
  if (!sessionId || sessionId.startsWith("temp_")) return;

  try {
    await db.collection(SESSIONS_COLLECTION).doc(sessionId).update({
      ...updates,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Session] Error updateSession:", err.message);
  }
}

/**
 * Avanzar la etapa de la sesión (con validación de transición)
 */
async function advanceStage(sessionId, currentStage, newStage) {
  if (!canTransition(currentStage, newStage)) {
    console.warn(`[Session] Transición inválida: ${currentStage} → ${newStage}. Ignorando.`);
    return false;
  }

  await updateSession(sessionId, { currentStage: newStage });
  console.log(`[Session] Etapa avanzada: ${currentStage} → ${newStage}`);
  return true;
}

/**
 * Actualizar entidades extraídas (merge, no reemplazar)
 */
async function updateEntities(sessionId, newEntities) {
  if (!sessionId || sessionId.startsWith("temp_")) return;

  try {
    const ref = db.collection(SESSIONS_COLLECTION).doc(sessionId);
    const snap = await ref.get();
    if (!snap.exists) return;

    const current = snap.data().extractedEntities || {};
    const merged = { ...current };

    // Solo actualizar campos que tienen valor no vacío
    for (const [key, value] of Object.entries(newEntities)) {
      if (value !== undefined && value !== null && value !== "" && value !== 0) {
        merged[key] = value;
      }
    }

    await ref.update({
      extractedEntities: merged,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Session] Error updateEntities:", err.message);
  }
}

/**
 * Incrementar contador de turnos y actualizar último mensaje
 */
async function recordTurn(sessionId, userMessage, botReply, intent, confidence) {
  if (!sessionId || sessionId.startsWith("temp_")) return;

  try {
    const ref = db.collection(SESSIONS_COLLECTION).doc(sessionId);
    const snap = await ref.get();
    if (!snap.exists) return;

    const data = snap.data();
    const turnCount = (data.turnCount || 0) + 1;

    // Rastrear confianza baja consecutiva
    let lowConfidenceStreak = data.lowConfidenceStreak || 0;
    if (confidence < 0.5) {
      lowConfidenceStreak++;
    } else {
      lowConfidenceStreak = 0;
    }

    await ref.update({
      turnCount,
      lastUserMessage: (userMessage || "").substring(0, 500),
      lastBotReply: (botReply || "").substring(0, 500),
      lastUserIntent: intent || "",
      confidenceScore: confidence || 0,
      lowConfidenceStreak,
      updatedAt: new Date().toISOString(),
    });

    return { turnCount, lowConfidenceStreak };
  } catch (err) {
    console.error("[Session] Error recordTurn:", err.message);
    return { turnCount: 0, lowConfidenceStreak: 0 };
  }
}

/**
 * Registrar una pregunta hecha por el bot para evitar repeticiones.
 * Guarda las últimas 3 preguntas con su estado.
 *
 * @param {string} sessionId — ID de sesión
 * @param {string} question — Pregunta resumida
 * @param {string} entityAsked — Entidad que se pedía (ej: "address", "selectedVariant")
 */
async function recordQuestion(sessionId, question, entityAsked) {
  if (!sessionId || sessionId.startsWith("temp_")) return;

  try {
    const ref = db.collection(SESSIONS_COLLECTION).doc(sessionId);
    const snap = await ref.get();
    if (!snap.exists) return;

    const data = snap.data();
    const recent = data.recentQuestions || [];

    // Agregar nueva pregunta
    recent.push({
      question: (question || "").substring(0, 200),
      entityAsked: entityAsked || "",
      answered: false,
      answer: "",
      askedAt: new Date().toISOString(),
    });

    // Mantener solo las últimas 5
    const trimmed = recent.slice(-5);

    await ref.update({
      recentQuestions: trimmed,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Session] Error recordQuestion:", err.message);
  }
}

/**
 * Marcar preguntas como respondidas cuando se detectan entidades.
 *
 * @param {string} sessionId — ID de sesión
 * @param {Object} detectedEntities — Entidades detectadas
 */
async function markQuestionsAnswered(sessionId, detectedEntities) {
  if (!sessionId || sessionId.startsWith("temp_") || !detectedEntities) return;

  try {
    const ref = db.collection(SESSIONS_COLLECTION).doc(sessionId);
    const snap = await ref.get();
    if (!snap.exists) return;

    const data = snap.data();
    const recent = data.recentQuestions || [];
    let changed = false;

    for (const q of recent) {
      if (!q.answered && q.entityAsked && detectedEntities[q.entityAsked]) {
        q.answered = true;
        q.answer = String(detectedEntities[q.entityAsked]).substring(0, 100);
        changed = true;
      }
    }

    if (changed) {
      await ref.update({
        recentQuestions: recent,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error("[Session] Error markQuestionsAnswered:", err.message);
  }
}

/**
 * Marcar sesión para escalamiento humano
 */
async function flagForEscalation(sessionId, reason) {
  await updateSession(sessionId, {
    escalationFlag: true,
    currentStage: "handoff_human",
    lastBotAction: `escalation: ${reason}`,
  });
}

/**
 * Obtener sesión por ID
 */
async function getSession(sessionId) {
  try {
    const snap = await db.collection(SESSIONS_COLLECTION).doc(sessionId).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...snap.data() };
  } catch (err) {
    console.error("[Session] Error getSession:", err.message);
    return null;
  }
}

module.exports = {
  getOrCreateSession,
  updateSession,
  advanceStage,
  updateEntities,
  recordTurn,
  recordQuestion,
  markQuestionsAnswered,
  flagForEscalation,
  getSession,
  SESSIONS_COLLECTION,
  SESSION_TIMEOUT_MS,
};
