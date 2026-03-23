// ==============================================
// GUARDRAILS — Anti-alucinación y validación
// Reglas duras que el modelo NO puede bypassear
// ==============================================

/**
 * Validar la respuesta de Gemini antes de enviarla al usuario
 *
 * @param {Object} aiResponse — respuesta estructurada de Gemini
 * @param {Object} session — sesión actual
 * @param {Object} catalogProducts — productos del catálogo (de toolExecutor)
 * @returns {Object} — { valid, issues[], correctedResponse }
 */
function validateResponse(aiResponse, session, catalogProducts) {
  const issues = [];
  let corrected = { ...aiResponse };

  // 1. Verificar que replyText no esté vacío
  if (!corrected.replyText || corrected.replyText.trim().length < 3) {
    issues.push("replyText vacío");
    corrected.replyText = _getSafeFallback(session.currentStage);
  }

  // 2. Detectar precios inventados en replyText
  const priceMatches = corrected.replyText.match(/₡[\d,.]+ /g);
  if (priceMatches && catalogProducts?.length > 0) {
    const catalogPrices = new Set();
    for (const p of catalogProducts) {
      if (p.basePrice) catalogPrices.add(p.basePrice);
      for (const v of (p.variants || [])) {
        if (v.price) catalogPrices.add(v.price);
      }
    }
    // Agregar precio de envío estándar
    catalogPrices.add(2500);

    for (const match of priceMatches) {
      const price = parseInt(match.replace(/[₡,.\s]/g, ""));
      if (price > 0 && !_isPriceValid(price, catalogPrices)) {
        issues.push(`Precio posiblemente inventado: ${match.trim()}`);
        corrected.hallucinationRisk = "high";
      }
    }
  }

  // 3. Detectar números de orden inventados
  const orderMatches = corrected.replyText.match(/AP-[\w-]+/gi);
  if (orderMatches) {
    // Si hay número de orden en la respuesta pero NO hay orderNumber en entidades
    if (!session.extractedEntities?.orderNumber) {
      issues.push("Número de orden mencionado sin ser creado por el sistema");
      corrected.replyText = corrected.replyText.replace(/AP-[\w-]+/gi, "[pedido pendiente]");
      corrected.hallucinationRisk = "high";
    }
  }

  // 4. Verificar que no confirme pagos sin validación
  const paymentConfirmPatterns = [
    /pago (confirmado|verificado|aprobado|recibido)/i,
    /ya recibimos tu pago/i,
    /pago exitoso/i,
  ];
  for (const pattern of paymentConfirmPatterns) {
    if (pattern.test(corrected.replyText) && session.currentStage !== "order_confirmation") {
      issues.push("Bot intentó confirmar pago sin validación del sistema");
      corrected.replyText = corrected.replyText.replace(pattern, "pago pendiente de verificación");
      corrected.hallucinationRisk = "high";
    }
  }

  // 5. Verificar transición de etapa válida
  if (corrected.shouldAdvanceStage && corrected.nextStage) {
    const { canTransition } = require("./stateMachine");
    if (!canTransition(session.currentStage, corrected.nextStage)) {
      issues.push(`Transición inválida: ${session.currentStage} → ${corrected.nextStage}`);
      corrected.shouldAdvanceStage = false;
      corrected.nextStage = "";
    }
  }

  // 6. Verificar confianza mínima
  if (corrected.confidence < 0.3) {
    issues.push("Confianza muy baja");
    if (!corrected.needsClarification) {
      corrected.needsClarification = true;
      corrected.clarificationQuestion = corrected.clarificationQuestion ||
        "¿Me podés dar más detalles para ayudarte mejor?";
    }
  }

  // 7. Sanitizar contexto interno filtrado
  corrected.replyText = sanitizeForUser(corrected.replyText);

  return {
    valid: issues.length === 0,
    issues,
    correctedResponse: corrected,
  };
}

/**
 * Verificar si un precio puede ser válido (dentro de rango de catálogo)
 */
function _isPriceValid(price, catalogPrices) {
  // El precio debe ser exactamente un precio del catálogo, o una suma válida
  for (const cp of catalogPrices) {
    if (Math.abs(price - cp) < 10) return true; // Tolerancia de ₡10
  }

  // O una suma de precios (para totales)
  const priceArr = Array.from(catalogPrices);
  for (let i = 0; i < priceArr.length; i++) {
    for (let j = i; j < priceArr.length; j++) {
      const sum = priceArr[i] + priceArr[j];
      if (Math.abs(price - sum) < 10) return true;
    }
  }

  // Permitir múltiplos de precios existentes (cantidad > 1)
  for (const cp of catalogPrices) {
    for (let mult = 1; mult <= 10; mult++) {
      if (Math.abs(price - cp * mult) < 10) return true;
      // Con envío
      if (Math.abs(price - (cp * mult + 2500)) < 10) return true;
    }
  }

  return false;
}

/**
 * Verificar confianza y decidir si hay que pedir aclaración
 */
function checkConfidence(aiResponse, session) {
  const confidence = aiResponse.confidence || 0;
  const lowStreak = session.lowConfidenceStreak || 0;

  // Si confianza es baja 3 veces seguidas → handoff humano
  if (confidence < 0.4 && lowStreak >= 2) {
    return {
      action: "escalate",
      reason: "Confianza baja sostenida — 3+ turnos sin entender al cliente",
    };
  }

  // Si confianza es baja → pedir aclaración
  if (confidence < 0.5) {
    return {
      action: "clarify",
      reason: "Confianza baja — necesita más información del cliente",
    };
  }

  return { action: "proceed", reason: null };
}

/**
 * Sanitización mínima final para el texto que va al usuario.
 * Ya no necesitamos 30+ regex porque Gemini devuelve JSON estructurado.
 */
function sanitizeForUser(text) {
  if (!text) return "";

  let clean = text;

  // Remover cualquier JSON residual
  if (clean.includes('"action"') || clean.includes('"orderData"')) {
    const actionIndex = clean.indexOf('","action"');
    if (actionIndex > -1) {
      clean = clean.substring(0, actionIndex);
    }
  }

  // Remover markdown de código
  clean = clean.replace(/```json?\n?/g, "").replace(/```$/g, "");

  // Remover meta-texto obvio (catch-all mínimo)
  clean = clean.replace(/^\s*\[SYSTEM[^\]]*\][^\n]*/gm, "");
  clean = clean.replace(/^\s*\(SYSTEM\)[^\n]*/gm, "");
  clean = clean.replace(/^\s*CONTEXTO[^\n]*/gm, "");

  // Limpiar espacios extras
  clean = clean.replace(/\n{3,}/g, "\n\n").trim();

  // Remover comillas envolventes
  clean = clean.replace(/^["']|["']$/g, "").trim();

  if (!clean || clean.length < 3) {
    return "¿Me podés dar más detalles? 😊";
  }

  return clean;
}

/**
 * Fallback seguro por etapa
 */
function _getSafeFallback(stage) {
  const fallbacks = {
    greeting: "¡Hola! 😊 Soy Pauli de Aquí Pauli. ¿En qué te puedo ayudar?",
    discovery: "¿Qué tipo de producto estás buscando? Tenemos ropa, calzado y accesorios 🛍️",
    product_selection: "¿Me podés decir cuál producto te interesa para darte más detalles? 😊",
    variant_selection: "¿Qué talla o color preferís? 😊",
    address_capture: "Para el envío, ¿me podés dar tu dirección? (provincia, cantón, distrito y señas) 📍",
    delivery_validation: "¿Está correcta la información? ¿Procedo con el pedido? ✅",
    payment_pending: "¿Ya pudiste hacer la transferencia? Esperamos tu comprobante 😊",
    payment_verification: "Tu comprobante está siendo verificado. Te aviso en cuanto se confirme 🙏",
    order_confirmation: "¡Tu pedido está confirmado! ¿Necesitás algo más? 🎉",
    handoff_human: "Te voy a conectar con alguien del equipo que te puede ayudar mejor 🙏",
    closed: "¡Gracias por tu compra! Escribinos cuando necesités 😊",
  };
  return fallbacks[stage] || "¿En qué te puedo ayudar? 😊";
}

module.exports = {
  validateResponse,
  checkConfidence,
  sanitizeForUser,
};
