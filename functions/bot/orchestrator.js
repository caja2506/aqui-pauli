// ==============================================
// ORCHESTRATOR — Orquestador principal del bot conversacional
// Coordina todas las capas: sesión → contexto → IA → tools → guardrails → respuesta → log
// ==============================================

const { defineSecret } = require("firebase-functions/params");
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// Capas del bot
const { getOrCreateSession, updateSession, advanceStage, updateEntities, recordTurn, recordQuestion, markQuestionsAnswered, flagForEscalation } = require("./sessionManager");
const { buildConversationContext } = require("./contextBuilder");
const { getStageUIConfig, getStageFallbackBehavior, getAutoAdvanceTarget, isToolAllowed, canTransition } = require("./stateMachine");
const { callGemini, getGenAIInstance, GEMINI_MODEL } = require("./aiAdapter");
const { executeTool, getProductCatalog } = require("./toolExecutor");
const { validateResponse, checkConfidence, sanitizeForUser } = require("./guardrails");
const { formatReply } = require("./responseFormatter");
const { shouldUpdateSummary, generateUpdatedSummary, saveSummary } = require("./summaryManager");
const { logTurn, logError } = require("./botLogger");

// Importaciones del proyecto existente
const { db } = require("../utils");
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

      // Dirección guardada — inyectar siempre que haya algún dato
      if (contact.lastAddress && !session.extractedEntities?.address) {
        const addr = contact.lastAddress;
        const addrParts = [addr.provincia, addr.canton, addr.distrito].filter(Boolean);
        if (addrParts.length > 0) {
          entitiesToMerge.address = addrParts.join(", ") + (addr.señas ? ` — ${addr.señas}` : "");
        } else if (addr.señas) {
          // Fallback: si solo hay señas (datos legacy o mal guardados)
          entitiesToMerge.address = addr.señas;
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
    const [catalogResult, orderByNumber, ordersByPhone, ordersByName, chatHistory] = await Promise.all([
      getProductCatalog({ limit: 15 }),
      getOrderContext(messageText),
      getOrdersByPhone(phone),
      getOrdersByCustomerInfo(contact),
      _loadChatHistory(contactId, 15),
    ]);

    const catalogData = catalogResult.success ? catalogResult.data.formatted : "Catálogo no disponible.";
    const catalogProducts = catalogResult.success ? catalogResult.data.products : [];
    const orderData = [orderByNumber, ordersByPhone, ordersByName].filter(Boolean).join("\n");

    // ================================================
    // 2b. DETECTAR SELECCIÓN DE DIRECCIÓN (provincia/cantón/distrito)
    // Si el último mensaje del bot preguntó por provincia/cantón/distrito,
    // y el usuario respondió con un nombre válido, guardarlo en entidades.
    // ================================================
    await _extractAddressSelection(messageText, session, chatHistory);

    // ================================================
    // 3. CONSTRUIR CONTEXTO
    // ================================================
    const { systemInstruction, contextPrompt } = await buildConversationContext(
      session,
      messageText,
      contact,
      catalogData,
      orderData,
      chatHistory,
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
    // 6b. AUTO-AVANZAR ETAPA basado en reglas del stateMachine
    // ================================================
    const autoTarget = getAutoAdvanceTarget(session.currentStage, aiResponse.intent, aiResponse.detectedEntities);
    if (autoTarget && canTransition(session.currentStage, autoTarget)) {
      console.log(`[Orchestrator] Auto-avance: ${session.currentStage} → ${autoTarget} (intent: ${aiResponse.intent})`);
      await advanceStage(session.id, session.currentStage, autoTarget);
      session.currentStage = autoTarget;
    }

    // ================================================
    // 7. EJECUTAR TOOL (si Gemini lo pide)
    // ================================================
    let toolResult = null;
    let orderCreated = null;

    // Auto-corregir: si el usuario envió un producto referenciado del catálogo,
    // SIEMPRE forzar getProductBySku — sin importar qué intent detectó Gemini.
    // El tag [PRODUCTO REFERENCIADO:] fue inyectado por webhook.js al detectar context.referred_product
    const refMatch = messageText.match(/\[PRODUCTO REFERENCIADO:\s*([^\]—]+)/);
    if (refMatch && aiResponse.toolToCall !== "getProductBySku") {
      const refProductName = refMatch[1].trim().split(" - ")[0].trim(); // quitar variante
      console.log(`[Orchestrator] Auto-corrigiendo: producto referenciado "${refProductName}" → forzando getProductBySku (Gemini dijo ${aiResponse.intent})`);
      aiResponse.intent = "product_inquiry";
      aiResponse.toolToCall = "getProductBySku";
      aiResponse.toolPayload = { productName: refProductName };
    }

    // Auto-corregir: si Gemini detecta product_inquiry pero no llama tool,
    // elegir la tool correcta según contexto
    if (aiResponse.intent === "product_inquiry" && (!aiResponse.toolToCall || aiResponse.toolToCall === "none")) {
      const selectedProduct = aiResponse.detectedEntities?.selectedProduct || session.extractedEntities?.selectedProduct;
      if (selectedProduct) {
        // Ya hay producto seleccionado → necesitamos variantes
        console.log(`[Orchestrator] Auto-corrigiendo: product_inquiry con producto "${selectedProduct}" → forzando getProductBySku`);
        aiResponse.toolToCall = "getProductBySku";
        aiResponse.toolPayload = { productName: selectedProduct };
      } else {
        // No hay producto → mostrar catálogo
        console.log("[Orchestrator] Auto-corrigiendo: product_inquiry sin tool → forzando getProductCatalog");
        aiResponse.toolToCall = "getProductCatalog";
        aiResponse.toolPayload = aiResponse.toolPayload || {};
      }
    }

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

      // Re-llamar a Gemini con el resultado de la tool para generar respuesta inteligente
      // Esto es CRÍTICO para la calidad conversacional — Gemini necesita ver los datos
      // de la tool para generar una respuesta natural y útil.
      if (toolResult.success && !["createOrderDraft", "handoffToHuman"].includes(aiResponse.toolToCall)) {
        try {
          const toolDataStr = JSON.stringify(toolResult.data || {}).substring(0, 3000);
          const followUpPrompt = `${contextPrompt}\n\n[RESULTADO DE TOOL: ${aiResponse.toolToCall}]\n${toolDataStr}\n\n[INSTRUCCIÓN]\nEl cliente preguntó: "${messageText}"\nUsá los datos de la tool para dar una respuesta natural, útil y en ESPAÑOL.\nSi hay productos, mencioná los más relevantes con su precio.\nSi es bajo pedido, explicá las condiciones.\nNO repitas el saludo. NO listes TODOS los productos, solo los relevantes.`;

          const { callGemini: callGeminiFollowUp } = require("./aiAdapter");
          const followUp = await callGeminiFollowUp(
            apiKey,
            systemInstruction,
            followUpPrompt,
            messageText,
          );

          if (followUp && followUp.replyText && followUp.replyText.length > 20 && !followUp._isFallback) {
            aiResponse.replyText = followUp.replyText;
            // Actualizar buttonsHint si la segunda llamada lo devuelve
            if (followUp.buttonsHint && followUp.buttonsHint !== "none") {
              aiResponse.buttonsHint = followUp.buttonsHint;
            }
            console.log("[Orchestrator] Segunda llamada Gemini exitosa — respuesta enriquecida con datos de tool");
          }
        } catch (err) {
          console.warn("[Orchestrator] Segunda llamada Gemini falló, usando template:", err.message);
          // Fallback: usar template si la segunda llamada falla
          if (aiResponse.replyText.length < 50 || !aiResponse.replyText.includes("₡")) {
            const toolSummary = _summarizeToolResult(aiResponse.toolToCall, toolResult.data);
            if (toolSummary) {
              aiResponse.replyText = aiResponse.replyText + "\n\n" + toolSummary;
            }
          }
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
    // 9b. DETERMINAR BOTONES INTERACTIVOS
    // ================================================
    // Botones se generan usando buttonsHint de Gemini + datos reales del catálogo.
    const stageAfter = aiResponse.nextStage || session.currentStage;
    const lastTool = toolsCalled[toolsCalled.length - 1] || null;
    let buttons = _autoGenerateButtons(stageAfter, reply, session, orderCreated, catalogProducts, lastTool, aiResponse);

    // Validar límites de WhatsApp para botones
    if (buttons.length > 0) {
      buttons = buttons.map(b => ({
        id: (b.id || b.title || "btn").substring(0, 256),
        title: (b.title || "Opción").substring(0, 20),
        ...(b.description ? { description: b.description.substring(0, 72) } : {}),
      }));
      console.log(`[Orchestrator] Enviando ${buttons.length} botones:`, buttons.map(b => b.title).join(", "));
    }

    // ================================================
    // 10. ACTUALIZAR SESIÓN
    // ================================================
    // Marcar preguntas previas como respondidas si se detectaron entidades
    if (aiResponse.detectedEntities) {
      await markQuestionsAnswered(session.id, aiResponse.detectedEntities);
      await updateEntities(session.id, aiResponse.detectedEntities);
    }

    // Registrar pregunta del bot (si la respuesta contiene "?")
    if (reply.includes("?")) {
      // Detectar qué entidad se está pidiendo
      const entityMap = {
        talla: "selectedVariant", color: "selectedVariant",
        dirección: "address", provincia: "address", cantón: "address",
        nombre: "customerName", pago: "paymentMethod",
        cantidad: "quantity", cuántos: "quantity",
      };
      const replyLower = reply.toLowerCase();
      let entityAsked = "";
      for (const [keyword, entity] of Object.entries(entityMap)) {
        if (replyLower.includes(keyword)) {
          entityAsked = entity;
          break;
        }
      }
      // Extraer solo la pregunta (después del último salto de línea que contenga "?")
      const questionMatch = reply.match(/[^\n]*\?[^\n]*/g);
      const questionText = questionMatch ? questionMatch[questionMatch.length - 1].trim() : reply.substring(0, 100);
      await recordQuestion(session.id, questionText, entityAsked);
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
      buttons,
      intent: aiResponse.intent,
      confidence: aiResponse.confidence,
      needsHumanReview: needsHuman,
      orderCreated,
      suggestedProductIds: [],
    };

  } catch (err) {
    console.error("[Orchestrator] Error fatal:", err);
    const sessionId = sessionStateBefore?.id || "unknown";
    const currentStage = sessionStateBefore?.currentStage || "greeting";
    await logError(sessionId, err, `Processing message: "${(messageText || "").substring(0, 100)}"`);

    // REGLA CRÍTICA: El fallback NUNCA reinicia la conversación.
    // Usa un mensaje contextual basado en la etapa actual.
    const { _getSafeFallback } = require("./guardrails");
    const fallbackReply = _getSafeFallback(currentStage);
    const stageUI = getStageUIConfig(currentStage);

    return {
      type: "auto_reply",
      reply: fallbackReply,
      buttons: stageUI.buttonsEnabled ? stageUI.fixedButtons : [],
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
 * Cargar los últimos N mensajes del contacto para dar contexto a Gemini.
 */
async function _loadChatHistory(contactId, limit = 15) {
  if (!contactId) return [];

  try {
    const snap = await db.collection("crm_contacts").doc(contactId)
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    if (snap.empty) return [];

    return snap.docs.map(doc => {
      const d = doc.data();
      return {
        direction: d.direction || "inbound",
        content: (d.content || "").substring(0, 300),
        createdAt: d.createdAt || "",
        intent: d.intent || "",
      };
    }).reverse(); // Más antiguo primero
  } catch (err) {
    console.warn("[Orchestrator] Error cargando historial:", err.message);
    return [];
  }
}

/**
 * Auto-generar botones interactivos basados en:
 * 0. Contexto de la PREGUNTA ACTUAL del bot (máxima prioridad)
 * 1. Configuración de UI de la etapa (stateMachine.uiConfig)
 * 2. Resultados reales de tools (variantes, productos)
 * 3. Estado de la sesión (orden creada, producto seleccionado)
 *
 * PRINCIPIO: Los botones vienen del catálogo, tools, o config — NUNCA de Gemini.
 * REGLA NUEVA: Los botones deben ser CONTEXTUALMENTE CORRECTOS para la pregunta actual.
 */
function _autoGenerateButtons(stage, reply, session, orderCreated, catalogProducts, lastTool, aiResponse) {
  const uiConfig = getStageUIConfig(stage);

  // Si la etapa tiene botones deshabilitados, no enviar nada
  if (!uiConfig.buttonsEnabled) return [];

  const toolName = lastTool?.name || "";
  const toolData = lastTool?.result?.data || null;
  const toolSuccess = lastTool?.result?.success || false;
  const entities = session.extractedEntities || {};
  const buttonsHint = aiResponse?.buttonsHint || "none";

  // ══════════════════════════════════════════════════════
  // PRIORIDAD -1: buttonsHint DE GEMINI (fuente principal)
  // Gemini sabe exactamente qué está preguntando.
  // ══════════════════════════════════════════════════════
  const regexFallback = _detectQuestionType(reply);
  const effectiveHint = (buttonsHint !== "none") ? buttonsHint : _mapRegexToHint(regexFallback);
  console.log(`[Buttons] buttonsHint="${buttonsHint}", regexFallback="${regexFallback}", effectiveHint="${effectiveHint}", stage="${stage}"`);

  // ── confirm_yes_no: Sí / No ──
  if (effectiveHint === "confirm_yes_no") {
    return [
      { id: "confirm_yes", title: "Sí ✅" },
      { id: "confirm_no", title: "No ❌" },
    ];
  }

  // ── free_text: Sin botones (cantidad, señas, nombre, etc.) ──
  if (effectiveHint === "free_text") {
    return [];
  }

  // ── show_variants: Variantes del producto ACTUAL solamente ──
  if (effectiveHint === "show_variants") {
    // Primero: variantes desde tool data (getProductBySku)
    if (toolName === "getProductBySku" && toolSuccess && toolData?.variants) {
      const variants = toolData.variants.filter(v => v.stock > 0 || v.supplyType === "bajo_pedido");
      if (variants.length >= 2) {
        return variants.slice(0, 10).map(v => ({
          id: `variant_${v.id}`,
          title: v.name.substring(0, 20),
        }));
      }
    }
    // Segundo: variantes del producto seleccionado desde catálogo pre-cargado
    const selectedProduct = entities.selectedProduct;
    if (selectedProduct && catalogProducts?.length > 0) {
      const product = catalogProducts.find(p =>
        p.name && p.name.toLowerCase().includes(selectedProduct.toLowerCase())
      );
      if (product?.variants?.length >= 2) {
        const available = product.variants.filter(v => v.stock > 0 || v.supplyType === "bajo_pedido");
        if (available.length >= 2) {
          return available.slice(0, 10).map(v => ({
            id: `variant_${v.id || v.sku || v.name}`,
            title: (v.name || v.sku || "Opción").substring(0, 20),
          }));
        }
      }
    }
    // Fallback: si no hay variantes, no mostrar botones
    return [];
  }

  // ── show_products: Productos mencionados en la respuesta ──
  if (effectiveHint === "show_products") {
    // Buscar productos del catálogo que el bot mencionó en su respuesta
    const replyLower = (reply || "").toLowerCase();
    if (catalogProducts?.length > 0) {
      const mentioned = catalogProducts.filter(p =>
        p.name && replyLower.includes(p.name.toLowerCase())
      );
      if (mentioned.length >= 2) {
        return mentioned.slice(0, 10).map(p => ({
          id: `product_${p.id}`,
          title: p.name.substring(0, 20),
        }));
      }
    }
    // Fallback: productos del tool data
    if (toolName === "getProductCatalog" && toolSuccess && toolData?.products?.length >= 2) {
      return toolData.products.slice(0, 10).map(p => ({
        id: `product_${p.id}`,
        title: p.name.substring(0, 20),
      }));
    }
    return [];
  }

  // ── ask_provincia: Lista de provincias CR ──
  if (effectiveHint === "ask_provincia") {
    return _getAddressButtons("provincia", null, null);
  }

  // ── ask_canton: Lista de cantones filtrados por provincia ──
  if (effectiveHint === "ask_canton") {
    return _getAddressButtons("canton", entities._addressProvincia || null, null);
  }

  // ── ask_distrito: Lista de distritos filtrados ──
  if (effectiveHint === "ask_distrito") {
    return _getAddressButtons("distrito", entities._addressProvincia || null, entities._addressCanton || null);
  }

  // ══════════════════════════════════════════════════════
  // BOTONES DE CONTEXTO (si Gemini no envió hint específico)
  // ══════════════════════════════════════════════════════

  // Post-orden: botones de seguimiento
  const hasOrderNumber = !!entities.orderNumber;
  if (orderCreated || hasOrderNumber) {
    return [
      { id: "action_send_proof", title: "Enviar comprobante 📸" },
      { id: "action_order_status", title: "Ver mi pedido 📋" },
      { id: "action_new_order", title: "Hacer otro pedido 🛍️" },
    ];
  }

  // Producto+variante+dirección: confirmar pedido
  const hasProduct = !!entities.selectedProduct;
  const hasVariant = !!entities.selectedVariant;
  const hasAddress = !!entities.address;

  if (hasProduct && hasVariant && hasAddress) {
    return [
      { id: "action_confirm_order", title: "Confirmar Pedido ✅" },
      { id: "action_change_address", title: "Cambiar dirección" },
      { id: "action_view_catalog", title: "Ver más productos" },
    ];
  }

  // Producto+variante seleccionados, sin dirección: confirmar/cambiar
  if (hasProduct && hasVariant && !hasAddress) {
    return [
      { id: "action_confirm", title: "Confirmar ✅" },
      { id: "action_change_product", title: "Cambiar producto" },
      { id: "action_view_catalog", title: "Ver Catálogo 📋" },
    ];
  }

  // ── Botones fijos de la configuración de etapa ──
  if (uiConfig.buttonMode === "fixed" && uiConfig.fixedButtons.length > 0) {
    return [...uiConfig.fixedButtons];
  }

  // ── Botones híbridos ──
  if (uiConfig.buttonMode === "hybrid" && uiConfig.fixedButtons.length > 0) {
    return [...uiConfig.fixedButtons];
  }

  // ══════════════════════════════════════════════════════
  // SAFETY NET: Auto-detectar productos mencionados en el reply
  // Si el bot menciona 2+ productos del catálogo y hace una pregunta,
  // mostrarlos como botones (Gemini olvidó enviar show_products).
  // ══════════════════════════════════════════════════════
  if (catalogProducts?.length > 0 && reply && reply.includes("?")) {
    const replyLower = reply.toLowerCase();
    const mentioned = catalogProducts.filter(p =>
      p.name && replyLower.includes(p.name.toLowerCase())
    );
    if (mentioned.length >= 2) {
      console.log(`[Buttons] SAFETY NET: Detectados ${mentioned.length} productos en reply`);
      return mentioned.slice(0, 10).map(p => ({
        id: `product_${p.id}`,
        title: p.name.substring(0, 20),
      }));
    }
  }

  return [];
}

/**
 * Mapear resultado de _detectQuestionType (regex) al formato de buttonsHint.
 * Usado como fallback cuando Gemini no envía buttonsHint.
 */
function _mapRegexToHint(questionType) {
  const map = {
    confirmation: "confirm_yes_no",
    address_confirm: "confirm_yes_no",
    quantity: "free_text",
    name: "free_text",
    address_senas: "free_text",
    variant: "show_variants",
    address: "ask_provincia",
    address_provincia: "ask_provincia",
    address_canton: "ask_canton",
    address_distrito: "ask_distrito",
  };
  return map[questionType] || "none";
}

/**
 * Detecta el tipo de pregunta que el bot está haciendo en su reply.
 * FALLBACK: Solo se usa cuando Gemini no envía buttonsHint.
 *
 * @param {string} reply — texto de respuesta del bot
 * @returns {string} — "confirmation" | "quantity" | "address" | "address_provincia" |
 *                       "address_canton" | "address_distrito" | "address_senas" |
 *                       "address_confirm" | "variant" | "name" | "none"
 */
function _detectQuestionType(reply) {
  if (!reply) return "none";
  const lower = reply.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // ── Confirmación: ¿agregar al carrito?, ¿procedemos?, ¿te gustaria? ──
  if (/te gustaria (agregar|ordenar|pedir|comprar|incluir)/i.test(lower) ||
      /\b(lo|la|los|las) (agrego|agregamos|queres|aparto)/i.test(lower) ||
      /(agregar|incluir).*(carrito|pedido)/i.test(lower) && lower.includes("?") ||
      /\b(procedemos|procedo|confirmo|te lo aparto|lo confirmamos)\b/i.test(lower) && lower.includes("?") ||
      /te gustaria ordenar/i.test(lower) ||
      /queres (confirmar|proceder|ordenar|pedir)/i.test(lower)) {
    return "confirmation";
  }

  // ── Cantidad: ¿cuántas unidades?, ¿cuántos pares?, ¿cuántos te gustaría llevar? ──
  if (/cuant[oa]s?\s+(unidades|pares|queres|necesitas|deseas|ocupas|te gustaria|vas a|te llev)/i.test(lower) ||
      /cuant[oa]s?\s+te\s+llev/i.test(lower) ||
      /cuant[oa]s?\s+\w+\s+te\s+gustaria/i.test(lower) ||
      /cuant[oa]s?\b.*\bllevar\b/i.test(lower) ||
      /cantidad/i.test(lower) && lower.includes("?")) {
    return "quantity";
  }

  // ── Confirmación de dirección ──
  if (/(confirmar?|correcta?|bien)\s*(la\s+)?(direccion|dir)/i.test(lower) && lower.includes("?") ||
      /esta\s+(bien|correcta?)\s*(la\s+)?(direccion|dir)/i.test(lower)) {
    return "address_confirm";
  }

  // ── Señas (texto libre dentro del flujo de dirección) ──
  if (/se[nñ]as/i.test(lower) && lower.includes("?") ||
      /indicame las se[nñ]as/i.test(lower) ||
      /referencia|punto de referencia/i.test(lower) && lower.includes("?")) {
    return "address_senas";
  }

  // ── Provincia ──
  if (/provincia/i.test(lower) && lower.includes("?") ||
      /en que provincia/i.test(lower) ||
      /indicame la provincia/i.test(lower) ||
      /selecciona tu provincia/i.test(lower)) {
    return "address_provincia";
  }

  // ── Cantón ──
  if (/canton/i.test(lower) && lower.includes("?") ||
      /en que canton/i.test(lower) ||
      /indicame el canton/i.test(lower) ||
      /selecciona.* canton/i.test(lower)) {
    return "address_canton";
  }

  // ── Distrito ──
  if (/distrito/i.test(lower) && lower.includes("?") ||
      /en que distrito/i.test(lower) ||
      /indicame el distrito/i.test(lower) ||
      /selecciona.* distrito/i.test(lower)) {
    return "address_distrito";
  }

  // ── Dirección general ──
  if (/direccion/i.test(lower) && lower.includes("?") ||
      /donde (te )?(lo |la )?(enviam|entregam)/i.test(lower) ||
      /direccion de envio/i.test(lower)) {
    return "address";
  }

  // ── Nombre del cliente ──
  if (/tu nombre/i.test(lower) && lower.includes("?") ||
      /como te llamas/i.test(lower) ||
      /a nombre de quien/i.test(lower)) {
    return "name";
  }

  // ── Variante/color/talla ──
  if (/(que )?(color|talla|variante|opcion)/i.test(lower) && lower.includes("?") ||
      /indicame el (color|talla)/i.test(lower) ||
      /cual te gustaria/i.test(lower) && lower.includes("?") ||
      /cual prefieres/i.test(lower) ||
      /cual te gusta mas/i.test(lower)) {
    return "variant";
  }

  return "none";
}

/**
 * Genera botones de dirección según el sub-paso actual.
 * Usa datos geográficos de Costa Rica.
 *
 * @param {string} step — "provincia" | "canton" | "distrito"
 * @param {string|null} provincia — provincia seleccionada (para filtrar cantones)
 * @param {string|null} canton — cantón seleccionado (para filtrar distritos)
 * @returns {Array<{id: string, title: string}>}
 */
function _getAddressButtons(step, provincia, canton) {
  const { getProvincias, getCantones, getDistritos } = require("./costaRicaGeo");

  if (step === "provincia") {
    return getProvincias().map(p => ({
      id: `prov_${p.toLowerCase().replace(/\s+/g, "_").normalize("NFD").replace(/[\u0300-\u036f]/g, "")}`,
      title: p.substring(0, 20),
    }));
  }

  if (step === "canton" && provincia) {
    const cantones = getCantones(provincia);
    return cantones.slice(0, 10).map(c => ({
      id: `cant_${c.toLowerCase().replace(/\s+/g, "_").normalize("NFD").replace(/[\u0300-\u036f]/g, "")}`,
      title: c.substring(0, 20),
    }));
  }

  if (step === "distrito" && provincia && canton) {
    const distritos = getDistritos(provincia, canton);
    return distritos.slice(0, 10).map(d => ({
      id: `dist_${d.toLowerCase().replace(/\s+/g, "_").normalize("NFD").replace(/[\u0300-\u036f]/g, "")}`,
      title: d.substring(0, 20),
    }));
  }

  return [];
}

/**
 * Genera un resumen legible de los datos de una tool para inyectar en el replyText.
 * Reemplaza la doble llamada a Gemini — ahora el resultado se formatea directamente.
 */
function _summarizeToolResult(toolName, data) {
  if (!data) return null;

  switch (toolName) {
    case "getProductBySku": {
      const p = data;
      let summary = `📦 *${p.name}*\n💰 Precio: ₡${(p.basePrice || 0).toLocaleString()}`;
      if (p.supplyType === "bajo_pedido") {
        summary += `\n⏳ Producto bajo pedido (15-20 días hábiles)`;
      }
      if (p.variants?.length > 0) {
        const available = p.variants.filter(v => v.stock > 0 || v.supplyType === "bajo_pedido");
        if (available.length > 0) {
          summary += `\n🎨 Opciones: ${available.map(v => v.name).join(", ")}`;
        }
      }
      return summary;
    }
    case "getProductCatalog": {
      if (data.products?.length > 0) {
        return `📋 Encontré ${data.products.length} productos. Te los muestro como opciones abajo 👇`;
      }
      return null;
    }
    case "checkStock": {
      if (data.available !== undefined) {
        return data.available > 0
          ? `✅ Hay ${data.available} unidades disponibles`
          : `⚠️ Sin stock actualmente`;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Detectar si el usuario respondió con una provincia/cantón/distrito
 * y guardar la selección en entidades de sesión.
 *
 * Esto permite que _getAddressButtons() filtre correctamente la siguiente lista.
 */
async function _extractAddressSelection(messageText, session, chatHistory) {
  if (!messageText || !session?.id) return;

  const { getProvincias, getCantones, getDistritos } = require("./costaRicaGeo");
  const { updateEntities } = require("./sessionManager");
  const entities = session.extractedEntities || {};

  // Buscar el último mensaje del BOT en el historial para saber qué preguntó
  const lastBotMsg = [...(chatHistory || [])].reverse().find(m => m.direction === "outbound");
  if (!lastBotMsg) return;

  const lastBotQuestion = _detectQuestionType(lastBotMsg.content || "");
  const userInput = messageText.trim();

  // Si el bot preguntó por provincia → el usuario está respondiendo con una provincia
  if (lastBotQuestion === "address_provincia" || lastBotQuestion === "address") {
    const provincias = getProvincias();
    const match = provincias.find(p =>
      p.toLowerCase() === userInput.toLowerCase() ||
      p.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") ===
      userInput.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    );
    if (match) {
      await updateEntities(session.id, { _addressProvincia: match, _addressCanton: "", _addressDistrito: "" });
      session.extractedEntities._addressProvincia = match;
      session.extractedEntities._addressCanton = "";
      session.extractedEntities._addressDistrito = "";
      console.log(`[Address] Provincia seleccionada: ${match}`);
    }
  }

  // Si el bot preguntó por cantón → el usuario está respondiendo con un cantón
  if (lastBotQuestion === "address_canton") {
    const provincia = entities._addressProvincia;
    if (provincia) {
      const cantones = getCantones(provincia);
      const match = cantones.find(c =>
        c.toLowerCase() === userInput.toLowerCase() ||
        c.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") ===
        userInput.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      );
      if (match) {
        await updateEntities(session.id, { _addressCanton: match, _addressDistrito: "" });
        session.extractedEntities._addressCanton = match;
        session.extractedEntities._addressDistrito = "";
        console.log(`[Address] Cantón seleccionado: ${match} (${provincia})`);
      }
    }
  }

  // Si el bot preguntó por distrito → el usuario está respondiendo con un distrito
  if (lastBotQuestion === "address_distrito") {
    const provincia = entities._addressProvincia;
    const canton = entities._addressCanton;
    if (provincia && canton) {
      const distritos = getDistritos(provincia, canton);
      const match = distritos.find(d =>
        d.toLowerCase() === userInput.toLowerCase() ||
        d.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") ===
        userInput.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      );
      if (match) {
        await updateEntities(session.id, { _addressDistrito: match });
        session.extractedEntities._addressDistrito = match;
        console.log(`[Address] Distrito seleccionado: ${match} (${provincia}, ${canton})`);
      }
    }
  }
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
        quantity: parseInt(entities.quantity) || 1,
      }];
    }
  }

  // CRITICAL FIX: Inyectar quantity de la sesión si Gemini no lo incluyó en los items
  // Gemini a veces envía items sin quantity, causando que la orden se cree con qty=1
  const sessionQty = parseInt(entities.quantity) || 0;
  if (sessionQty > 0 && payload.items && payload.items.length > 0) {
    for (const item of payload.items) {
      if (!item.quantity || item.quantity <= 0) {
        item.quantity = sessionQty;
        console.log(`[_buildOrderPayload] Inyectando quantity=${sessionQty} de sesión en item "${item.productName}"`);
      }
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
