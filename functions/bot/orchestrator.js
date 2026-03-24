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
    // Botones se generan del DATO REAL (catálogo/herramienta), nunca de Gemini.
    const stageAfter = aiResponse.nextStage || session.currentStage;
    const lastTool = toolsCalled[toolsCalled.length - 1] || null;
    let buttons = _autoGenerateButtons(stageAfter, reply, session, orderCreated, catalogProducts, lastTool);

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
 * 1. Configuración de UI de la etapa (stateMachine.uiConfig)
 * 2. Resultados reales de tools (variantes, productos)
 * 3. Estado de la sesión (orden creada, producto seleccionado)
 *
 * PRINCIPIO: Los botones vienen del catálogo, tools, o config — NUNCA de Gemini.
 */
function _autoGenerateButtons(stage, reply, session, orderCreated, catalogProducts, lastTool) {
  const uiConfig = getStageUIConfig(stage);

  // Si la etapa tiene botones deshabilitados, no enviar nada
  if (!uiConfig.buttonsEnabled) return [];

  const toolName = lastTool?.name || "";
  const toolData = lastTool?.result?.data || null;
  const toolSuccess = lastTool?.result?.success || false;

  // ── PRIORIDAD 0: Botones de ACCIÓN según estado del flujo de compra ──
  // Si ya tenemos producto + variante + dirección → el cliente está listo para confirmar
  const entities = session.extractedEntities || {};
  const hasProduct = !!entities.selectedProduct;
  const hasVariant = !!entities.selectedVariant;
  const hasAddress = !!entities.address;
  const currentIntent = session.lastIntent || "";

  // Si estamos en flujo de compra avanzado (dirección confirmada o intent de compra)
  if (hasProduct && hasVariant && hasAddress) {
    return [
      { id: "action_confirm_order", title: "Confirmar Pedido ✅" },
      { id: "action_change_address", title: "Cambiar dirección" },
      { id: "action_view_catalog", title: "Ver más productos" },
    ];
  }

  // Si tenemos producto y variante pero falta dirección → pedir dirección o confirmar
  if (hasProduct && hasVariant && !hasAddress && ["purchase", "confirmation"].includes(currentIntent)) {
    return [
      { id: "action_confirm", title: "Confirmar ✅" },
      { id: "action_change_product", title: "Cambiar producto" },
      { id: "action_view_catalog", title: "Ver Catálogo 📋" },
    ];
  }

  // ── PRIORIDAD 1: Botones generados por datos de TOOL ──
  // Variantes reales de getProductBySku
  if (toolName === "getProductBySku" && toolSuccess && toolData?.variants) {
    const variants = toolData.variants.filter(v => v.stock > 0 || v.supplyType === "bajo_pedido");
    if (variants.length >= 2) {
      return variants.slice(0, 10).map(v => ({
        id: `variant_${v.id}`,
        title: v.name.substring(0, 20),
      }));
    }
  }

  // Productos reales de getProductCatalog
  if (toolName === "getProductCatalog" && toolSuccess && toolData?.products?.length >= 2) {
    const products = toolData.products;
    if (products.length <= 10) {
      return products.map(p => ({
        id: `product_${p.id}`,
        title: p.name.substring(0, 20),
      }));
    }
    // Más de 10 → agrupar por categoría
    const categoryMap = {};
    for (const p of products) {
      const cat = p.category || "Otros";
      if (!categoryMap[cat]) categoryMap[cat] = [];
      categoryMap[cat].push(p);
    }
    const categories = Object.keys(categoryMap);
    if (categories.length >= 2 && categories.length <= 10) {
      return categories.slice(0, 10).map(cat => ({
        id: `cat_${cat.toLowerCase().replace(/\s+/g, "_")}`,
        title: cat.substring(0, 20),
      }));
    }
    return products.slice(0, 10).map(p => ({
      id: `product_${p.id}`,
      title: p.name.substring(0, 20),
    }));
  }

  // ── PRIORIDAD 2: Variantes desde catálogo pre-cargado (si hay producto seleccionado) ──
  const selectedProduct = session.extractedEntities?.selectedProduct;
  if (selectedProduct && catalogProducts?.length > 0) {
    const product = catalogProducts.find(p =>
      p.name && p.name.toLowerCase().includes(selectedProduct.toLowerCase())
    );
    if (product?.variants?.length >= 2) {
      const available = product.variants.filter(v => v.stock > 0 || v.supplyType === "bajo_pedido");
      if (available.length >= 2) {
        return available.slice(0, 10).map(v => ({
          id: `variant_${v.id}`,
          title: v.name.substring(0, 20),
        }));
      }
    }
  }

  // ── PRIORIDAD 3: Botones fijos de la configuración de etapa ──
  if (uiConfig.buttonMode === "fixed" && uiConfig.fixedButtons.length > 0) {
    return [...uiConfig.fixedButtons];
  }

  // ── PRIORIDAD 4: Botones híbridos (fijos si no hay contexto de tool) ──
  if (uiConfig.buttonMode === "hybrid" && uiConfig.fixedButtons.length > 0) {
    // Solo mostrar fijos si no hubo datos de tool más relevantes
    return [...uiConfig.fixedButtons];
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
