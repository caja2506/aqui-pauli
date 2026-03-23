// ==============================================
// ORCHESTRATOR — Orquestador principal del bot conversacional
// Coordina todas las capas: sesión → contexto → IA → tools → guardrails → respuesta → log
// ==============================================

const { defineSecret } = require("firebase-functions/params");
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// Capas del bot
const { getOrCreateSession, updateSession, advanceStage, updateEntities, recordTurn, flagForEscalation } = require("./sessionManager");
const { buildConversationContext } = require("./contextBuilder");
const { callGemini, getGenAIInstance, GEMINI_MODEL } = require("./aiAdapter");
const { executeTool, getProductCatalog } = require("./toolExecutor");
const { validateResponse, checkConfidence, sanitizeForUser } = require("./guardrails");
const { formatReply } = require("./responseFormatter");
const { shouldUpdateSummary, generateUpdatedSummary, saveSummary } = require("./summaryManager");
const { logTurn, logError } = require("./botLogger");

// Importaciones del proyecto existente
const { getOrderContext, getOrdersByPhone, getOrdersByCustomerInfo } = require("./legacyHelpers");

/**
 * Procesar un mensaje entrante del usuario.
 * Esta función reemplaza a processInboundMessage de conversation.js
 *
 * @param {string} messageText — texto del mensaje del usuario
 * @param {Object} contact — datos CRM del contacto
 * @param {Object} options — { phone, contactId, channel }
 * @returns {Object} — { type, reply, intent, confidence, needsHumanReview, orderCreated }
 */
async function processInboundMessage(messageText, contact, { phone, contactId, channel = "whatsapp" } = {}) {
  const startTime = Date.now();
  const errors = [];
  let toolsCalled = [];
  let aiResponse = null;
  let sessionStateBefore = null;

  try {
    // ================================================
    // 1. OBTENER O CREAR SESIÓN
    // ================================================
    const { session, isNew } = await getOrCreateSession(
      phone || contactId || "unknown",
      channel,
      contactId,
    );

    sessionStateBefore = { ...session };
    console.log(`[Orchestrator] Sesión: ${session.id}, etapa: ${session.currentStage}, turno: ${session.turnCount}, nueva: ${isNew}`);

    // ================================================
    // 1b. ENRIQUECER SESIÓN CON DATOS CRM DEL CONTACTO
    // ================================================
    // Si el contacto ya tiene datos guardados (nombre, dirección, pago),
    // inyectarlos en las entidades de la sesión para que Gemini los conozca.
    if (contact) {
      const entitiesToMerge = {};

      // Nombre del cliente
      if (contact.displayName && !session.extractedEntities?.customerName) {
        entitiesToMerge.customerName = contact.displayName;
      }

      // Dirección guardada
      if (contact.lastAddress && !session.extractedEntities?.address) {
        const addr = contact.lastAddress;
        const addrParts = [addr.provincia, addr.canton, addr.distrito].filter(Boolean);
        if (addrParts.length > 0) {
          entitiesToMerge.address = addrParts.join(", ") + (addr.señas ? ` — ${addr.señas}` : "");
        }
      }

      // Método de pago preferido
      if (contact.preferredPaymentMethod && !session.extractedEntities?.paymentMethod) {
        entitiesToMerge.paymentMethod = contact.preferredPaymentMethod;
      }

      // Actualizar sesión si hay datos nuevos del CRM
      if (Object.keys(entitiesToMerge).length > 0) {
        await updateEntities(session.id, entitiesToMerge);
        session.extractedEntities = { ...session.extractedEntities, ...entitiesToMerge };
        console.log(`[Orchestrator] Entidades CRM inyectadas:`, Object.keys(entitiesToMerge).join(", "));
      }
    }

    // ================================================
    // 2. OBTENER DATOS DE NEGOCIO (en paralelo)
    // ================================================
    const [catalogResult, orderByNumber, ordersByPhone, ordersByName] = await Promise.all([
      getProductCatalog({ limit: 15 }),
      getOrderContext(messageText),
      getOrdersByPhone(phone),
      getOrdersByCustomerInfo(contact),
    ]);

    const catalogData = catalogResult.success ? catalogResult.data.formatted : "Catálogo no disponible.";
    const catalogProducts = catalogResult.success ? catalogResult.data.products : [];
    const orderData = [orderByNumber, ordersByPhone, ordersByName].filter(Boolean).join("\n");

    // ================================================
    // 3. CONSTRUIR CONTEXTO
    // ================================================
    const { systemInstruction, contextPrompt } = buildConversationContext(
      session,
      messageText,
      contact,
      catalogData,
      orderData,
    );

    // ================================================
    // 4. LLAMAR A GEMINI
    // ================================================
    const apiKey = geminiApiKey.value();
    aiResponse = await callGemini(apiKey, systemInstruction, contextPrompt, messageText);
    console.log(`[Orchestrator] Gemini → intent: ${aiResponse.intent}, confidence: ${aiResponse.confidence}, tool: ${aiResponse.toolToCall}`);

    // ================================================
    // 5. VERIFICAR CONFIANZA
    // ================================================
    const confidenceCheck = checkConfidence(aiResponse, session);
    if (confidenceCheck.action === "escalate") {
      console.log(`[Orchestrator] Escalando: ${confidenceCheck.reason}`);
      await flagForEscalation(session.id, confidenceCheck.reason);

      const reply = sanitizeForUser(aiResponse.replyText) ||
        "Dejame conectarte con alguien del equipo para ayudarte mejor 🙏";

      await _logAndRecord(session, messageText, reply, aiResponse, toolsCalled, errors, [], startTime, sessionStateBefore);

      return {
        type: "escalate",
        reply,
        intent: aiResponse.intent,
        confidence: aiResponse.confidence,
        needsHumanReview: true,
        orderCreated: null,
      };
    }

    // ================================================
    // 6. VALIDAR CON GUARDRAILS
    // ================================================
    const validation = validateResponse(aiResponse, session, catalogProducts);
    if (!validation.valid) {
      console.log(`[Orchestrator] Guardrails issues: ${validation.issues.join(", ")}`);
    }
    aiResponse = validation.correctedResponse;

    // ================================================
    // 7. EJECUTAR TOOL (si Gemini lo pide)
    // ================================================
    let toolResult = null;
    let orderCreated = null;

    if (aiResponse.toolToCall && aiResponse.toolToCall !== "none") {
      // Enriquecer payload de createOrderDraft con datos de la sesión
      // porque Gemini a menudo envía payload vacío
      let enrichedPayload = aiResponse.toolPayload || {};

      if (aiResponse.toolToCall === "createOrderDraft") {
        enrichedPayload = _buildOrderPayload(enrichedPayload, session, contact);
        console.log(`[Orchestrator] createOrderDraft enriquecido:`, JSON.stringify(enrichedPayload).substring(0, 300));
      }

      toolResult = await executeTool(
        aiResponse.toolToCall,
        enrichedPayload,
        { contactId, phone, sessionId: session.id },
      );

      toolsCalled.push({
        name: aiResponse.toolToCall,
        payload: aiResponse.toolPayload,
        result: toolResult,
      });

      // Si se creó una orden, guardar referencia
      if (aiResponse.toolToCall === "createOrderDraft" && toolResult.success) {
        orderCreated = toolResult.data;
        // Actualizar entidades con el número de orden
        await updateEntities(session.id, { orderNumber: toolResult.data.orderNumber });
      }

      // Si la tool devuelve datos, re-llamar a Gemini con los resultados para respuesta informada
      if (toolResult.success && !["createOrderDraft", "handoffToHuman"].includes(aiResponse.toolToCall)) {
        // Re-llamar con contexto enriquecido
        const enrichedContext = `${contextPrompt}\n\n[RESULTADO DE CONSULTA: ${aiResponse.toolToCall}]\n${JSON.stringify(toolResult.data).substring(0, 800)}`;
        const enrichedResponse = await callGemini(apiKey, systemInstruction, enrichedContext, messageText);
        if (enrichedResponse && !enrichedResponse._isFallback) {
          // Mantener entidades y tool info del primer call, pero usar el nuevo replyText
          aiResponse.replyText = enrichedResponse.replyText;
          // Re-validar
          const revalidation = validateResponse(aiResponse, session, catalogProducts);
          aiResponse = revalidation.correctedResponse;
        }
      }
    }

    // ================================================
    // 8. DETECCIÓN DE CONFIRMACIÓN → CREAR ORDEN AUTOMÁTICAMENTE
    // ================================================
    if (!orderCreated && aiResponse.intent === "confirmation" && !toolsCalled.some(t => t.name === "createOrderDraft" && t.result?.success)) {
      const isConfirm = /^(s[ií]|dale|va|perfecto|correcto|ok|listo|claro|bueno|de una|jale|adelante|confirmo|sí por favor|si claro)/i.test(messageText.trim());
      const hasProduct = session.extractedEntities?.selectedProduct || session.cartSnapshot?.items?.length > 0;

      if (isConfirm && hasProduct) {
        console.log("[Orchestrator] Confirmación detectada — creando orden automáticamente");
        const orderPayload = _buildOrderPayload({}, session, contact);

        const draftResult = await executeTool("createOrderDraft", orderPayload, { contactId, phone, sessionId: session.id });

        if (draftResult.success) {
          orderCreated = draftResult.data;
          toolsCalled.push({ name: "createOrderDraft", payload: orderPayload, result: draftResult });
          await updateEntities(session.id, { orderNumber: draftResult.data.orderNumber });
          console.log(`[Orchestrator] Orden creada: ${draftResult.data.orderNumber}`);
        } else {
          console.warn(`[Orchestrator] Error creando orden desde confirmación: ${draftResult.error}`);
        }
      }
    }

    // ================================================
    // 9. FORMATEAR RESPUESTA FINAL
    // ================================================
    let reply = formatReply(aiResponse, toolResult, session);
    reply = sanitizeForUser(reply);

    // ================================================
    // 10. ACTUALIZAR SESIÓN
    // ================================================
    // Actualizar entidades detectadas
    if (aiResponse.detectedEntities) {
      await updateEntities(session.id, aiResponse.detectedEntities);
    }

    // Avanzar etapa si corresponde
    if (aiResponse.shouldAdvanceStage && aiResponse.nextStage) {
      await advanceStage(session.id, session.currentStage, aiResponse.nextStage);
    }

    // Si se creó orden, avanzar a payment_pending
    if (orderCreated) {
      await advanceStage(session.id, session.currentStage, "payment_pending");
    }

    // ================================================
    // 11. ACTUALIZAR RESUMEN (cada N turnos)
    // ================================================
    const turnInfo = await recordTurn(session.id, messageText, reply, aiResponse.intent, aiResponse.confidence);

    if (shouldUpdateSummary(turnInfo?.turnCount || session.turnCount, aiResponse)) {
      try {
        const genAI = getGenAIInstance(apiKey);
        const newSummary = await generateUpdatedSummary(
          genAI,
          GEMINI_MODEL,
          session.runningSummary,
          messageText,
          reply,
          aiResponse.detectedEntities,
        );
        await saveSummary(session.id, newSummary);
      } catch (sumErr) {
        console.warn("[Orchestrator] Error actualizando resumen:", sumErr.message);
      }
    }

    // ================================================
    // 12. LOG COMPLETO
    // ================================================
    await _logAndRecord(session, messageText, reply, aiResponse, toolsCalled, errors, validation.issues, startTime, sessionStateBefore);

    // ================================================
    // 13. RETORNAR RESULTADO
    // ================================================
    const needsHuman = aiResponse.toolToCall === "handoffToHuman" ||
      aiResponse.intent === "complaint" ||
      session.escalationFlag;

    return {
      type: needsHuman ? "escalate" : "auto_reply",
      reply,
      intent: aiResponse.intent,
      confidence: aiResponse.confidence,
      needsHumanReview: needsHuman,
      orderCreated,
      suggestedProductIds: [],
    };

  } catch (err) {
    console.error("[Orchestrator] Error fatal:", err);
    const sessionId = sessionStateBefore?.id || "unknown";
    await logError(sessionId, err, `Processing message: "${(messageText || "").substring(0, 100)}"`);

    return {
      type: "auto_reply",
      reply: "¡Disculpá! Tuve un problemita. ¿Me podés repetir qué necesitás? 😊",
      intent: "error",
      confidence: 0,
      needsHumanReview: true,
      orderCreated: null,
      suggestedProductIds: [],
    };
  }
}

/**
 * Helper interno para log y registro de turno
 */
async function _logAndRecord(session, userInput, finalReply, aiResponse, toolsCalled, errors, guardrailIssues, startTime, stateBefore) {
  const responseTimeMs = Date.now() - startTime;
  console.log(`[Orchestrator] Turno completado en ${responseTimeMs}ms`);

  await logTurn({
    sessionId: session.id,
    turnNumber: session.turnCount + 1,
    userInput,
    contextSent: `Stage: ${session.currentStage}, Summary: ${(session.runningSummary || "").substring(0, 100)}`,
    summarySent: session.runningSummary || "",
    sessionStateBefore: stateBefore,
    sessionStateAfter: session,
    toolsCalled,
    geminiRawResponse: aiResponse,
    finalReply,
    responseTimeMs,
    errors,
    guardrailIssues,
  });
}

/**
 * Construir payload para createOrderDraft usando datos de sesión/CRM como fallback.
 * Resuelve el problema de Gemini enviando payload vacío.
 */
function _buildOrderPayload(geminiPayload, session, contact) {
  const entities = session.extractedEntities || {};
  const cart = session.cartSnapshot || { items: [] };
  const payload = { ...geminiPayload };

  // Items: prioridad carrito > payload > entidades
  if (!payload.items || payload.items.length === 0) {
    if (cart.items && cart.items.length > 0) {
      payload.items = cart.items;
    } else if (entities.selectedProduct) {
      // Construir item mínimo desde entidades
      payload.items = [{
        productName: entities.selectedProduct,
        productId: entities.selectedProductId || "",
        variantName: entities.selectedVariant || "",
        variantId: entities.selectedVariantId || "",
        quantity: entities.quantity || 1,
      }];
    }
  }

  // Nombre del cliente: entidades > contacto CRM > payload
  if (!payload.customerName) {
    payload.customerName = entities.customerName || contact?.displayName || "";
  }

  // Dirección: entidades > contacto CRM > payload
  if (!payload.address) {
    if (entities.address) {
      payload.address = entities.address;
    } else if (contact?.lastAddress) {
      const addr = contact.lastAddress;
      const parts = [addr.provincia, addr.canton, addr.distrito].filter(Boolean);
      payload.address = parts.join(", ") + (addr.señas ? ` — ${addr.señas}` : "");
    }
  }

  // Método de pago
  if (!payload.paymentMethod) {
    payload.paymentMethod = entities.paymentMethod || contact?.preferredPaymentMethod || "sinpe";
  }

  return payload;
}

module.exports = {
  processInboundMessage,
  geminiApiKey,
};
