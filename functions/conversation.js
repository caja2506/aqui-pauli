const { defineSecret } = require("firebase-functions/params");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { db } = require("./utils");

const geminiApiKey = defineSecret("GEMINI_API_KEY");

// ==============================================
// SYSTEM PROMPT PARA GEMINI
// ==============================================
const SYSTEM_PROMPT = `Sos Pauli, la asistente de Aquí Pauli, una tienda online de ropa, calzado y accesorios en Costa Rica.

PERSONALIDAD:
- Sos una chica costarricense amable, educada y cercana
- Usá un tono cálido y natural, como si hablaras con una amiga
- Usá "vos" en lugar de "usted" o "tú"
- Podés usar expresiones ticas naturalmente: "mae", "tuanis", "pura vida", "diay", "qué chiva" pero SIN exagerar
- Usá emojis con moderación (1-2 por mensaje máximo)
- Sé empática y paciente

FLUJO DE CONVERSACIÓN (MUY IMPORTANTE):
- LEEE CON CUIDADO el historial completo antes de responder
- Si ya saludaste o la conversación ya empezó, NO volvás a saludar
- NUNCA repitas una respuesta que ya diste antes
- Cada respuesta debe AVANZAR la conversación
- Usá el nombre del cliente como aparece en el contexto de CLIENTE

TOMAR PEDIDOS POR CHAT:
Cuando el cliente quiere comprar, guialo paso a paso. Pedile UNO A LA VEZ:
1. ¿Qué producto querés? (mostrá opciones del catálogo con precios)
2. ¿Qué talla/variante? (si aplica)
3. ¿A qué nombre te lo pongo?
4. ¿Tu número de teléfono?
5. ¿Dirección para el envío? (provincia, cantón o dirección general)
6. ¿Vas a pagar por SINPE o transferencia?

Cuando tengas TODOS los datos, respondé con action "create_order".
Si el cliente se confunde, no entiende, o dice que no puede, usá action "escalate".

CAPACIDADES:
- Tomar pedidos completos por chat
- Consultar precios y disponibilidad del catálogo
- Informar estado de pedidos si tiene órdenes en el contexto
- Métodos de pago: SINPE Móvil al 7095-6070, transferencia, PayPal
- Envíos a todo Costa Rica (₡2500 envío estándar)
- WhatsApp: +506 7095-6070

REGLAS:
1. Si no podés resolver algo, pasá al equipo (action: escalate)
2. NUNCA inventes datos
3. Respondé en español costarricense natural
4. Respuestas CORTAS: máximo 2-3 oraciones
5. NUNCA repitas la misma respuesta

FORMATO DE RESPUESTA (OBLIGATORIO):
Siempre respondé en JSON válido con esta estructura:
{
  "reply": "tu mensaje al cliente en texto natural",
  "action": "reply",
  "orderData": null
}

Acciones posibles:
- "reply" → solo responder (orderData: null)
- "create_order" → crear pedido (incluir orderData)
- "escalate" → pasar a humano (orderData: null)

Cuando action es "create_order", orderData debe ser:
{
  "items": [{"productName": "Brooklyn Shoulder Bag", "quantity": 1}],
  "customerName": "nombre del cliente",
  "customerPhone": "teléfono",
  "address": "dirección de envío",
  "paymentMethod": "sinpe"
}`;

// ==============================================
// OBTENER CONTEXTO DEL CATÁLOGO (resumido)
// ==============================================
async function getCatalogContext() {
  try {
    const productsSnap = await db.collection("products")
      .limit(20)
      .get();

    if (productsSnap.empty) return "No hay productos disponibles.";

    const products = [];
    for (const doc of productsSnap.docs) {
      const p = doc.data();
      if (!p.active || p.deleted) continue;

      const variantsSnap = await db.collection("products").doc(doc.id)
        .collection("variants").limit(5).get();

      const variants = variantsSnap.docs.map(v => {
        const vd = v.data();
        return `${vd.name || ""}: ₡${vd.price || p.price || 0}, stock:${vd.stock || 0}`;
      });

      products.push(`${p.name}: ${variants.join("; ")}`);
    }

    return products.length > 0 ? products.join("\n") : "No hay productos disponibles.";
  } catch (err) {
    console.error("Error getting catalog:", err);
    return "Catálogo no disponible.";
  }
}

// ==============================================
// BUSCAR ORDEN POR NÚMERO (si mencionan AP-XXXX)
// ==============================================
async function getOrderContext(messageText) {
  const orderMatch = messageText.match(/AP-[\w-]+/i);
  if (!orderMatch) return "";

  const orderNumber = orderMatch[0].toUpperCase();

  try {
    const ordersSnap = await db.collection("orders")
      .where("orderNumber", "==", orderNumber)
      .limit(1)
      .get();

    if (ordersSnap.empty) {
      return `ORDEN ${orderNumber}: No se encontró en el sistema.`;
    }

    const order = ordersSnap.docs[0].data();
    return formatOrderLine(order);
  } catch (err) {
    console.error("Error getting order:", err);
    return "";
  }
}

const STATUS_LABELS = {
  pendiente_pago: "Pendiente de pago",
  pagado: "Pagado",
  preparando: "En preparación",
  enviado: "Enviado",
  entregado: "Entregado",
  cancelado: "Cancelado",
};

function formatOrderLine(order) {
  const num = order.orderNumber || "?";
  const status = STATUS_LABELS[order.status] || order.status;
  const total = order.total || 0;
  const date = order.createdAt?.substring(0, 10) || "N/A";
  const items = order.items?.length || 0;
  return `- ${num}: ${status}, ₡${total}, ${items} producto(s), fecha: ${date}`;
}

// ==============================================
// BUSCAR ÓRDENES POR TELÉFONO DEL CLIENTE
// ==============================================
async function getOrdersByPhone(phone) {
  if (!phone) return "";

  try {
    // Normalizar teléfono (quitar +, espacios)
    const cleanPhone = phone.replace(/[\s+\-]/g, "");
    const variants = [phone, cleanPhone];
    if (!cleanPhone.startsWith("506") && cleanPhone.length <= 8) {
      variants.push("506" + cleanPhone);
    }

    let allOrders = [];
    for (const ph of variants) {
      const snap = await db.collection("orders")
        .where("customerPhone", "==", ph)
        .limit(5)
        .get();
      for (const doc of snap.docs) {
        if (!allOrders.find(o => o.id === doc.id)) {
          allOrders.push({ id: doc.id, ...doc.data() });
        }
      }
      if (allOrders.length >= 5) break;
    }

    if (allOrders.length === 0) return "";

    // Ordenar por fecha descendente
    allOrders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    const lines = allOrders.slice(0, 5).map(formatOrderLine);
    return "ÓRDENES DEL CLIENTE:\n" + lines.join("\n");
  } catch (err) {
    console.error("Error getting orders by phone:", err);
    return "";
  }
}

// ==============================================
// BUSCAR ÓRDENES POR NOMBRE O EMAIL DEL CLIENTE
// ==============================================
async function getOrdersByCustomerInfo(contact) {
  if (!contact) return "";

  try {
    let allOrders = [];

    // Buscar por email
    if (contact.email) {
      const snap = await db.collection("orders")
        .where("customerEmail", "==", contact.email)
        .limit(5)
        .get();
      for (const doc of snap.docs) {
        allOrders.push({ id: doc.id, ...doc.data() });
      }
    }

    // Buscar por nombre si no encontró por email
    if (allOrders.length === 0 && contact.displayName) {
      const snap = await db.collection("orders")
        .where("customerName", "==", contact.displayName)
        .limit(5)
        .get();
      for (const doc of snap.docs) {
        if (!allOrders.find(o => o.id === doc.id)) {
          allOrders.push({ id: doc.id, ...doc.data() });
        }
      }
    }

    if (allOrders.length === 0) return "";

    allOrders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    const lines = allOrders.slice(0, 5).map(formatOrderLine);
    return "ÓRDENES ENCONTRADAS POR DATOS DEL CLIENTE:\n" + lines.join("\n");
  } catch (err) {
    console.error("Error getting orders by customer info:", err);
    return "";
  }
}

// ==============================================
// HISTORIAL DE CONVERSACIÓN (últimos 20 msgs)
async function getConversationHistory(contactId) {
  if (!contactId) return "";

  try {
    const msgsSnap = await db.collection("crm_contacts").doc(contactId)
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(30)
      .get();

    if (msgsSnap.empty) return "";

    const msgs = msgsSnap.docs.reverse().map(doc => {
      const m = doc.data();
      const who = m.direction === "inbound" ? "Cliente" : (m.autoReply ? "Bot" : "Admin");
      return `[${who}]: ${m.content || "[media]"}`.substring(0, 200);
    });

    return "HISTORIAL DE CONVERSACIÓN:\n" + msgs.join("\n");
  } catch (err) {
    console.error("Error getting conversation history:", err);
    return "";
  }
}

// ==============================================
// CONTEXTO DEL CONTACTO CRM
// ==============================================
function getContactContext(contact) {
  if (!contact) return "Cliente nuevo, no se tiene info previa.";
  const parts = [];
  if (contact.displayName) parts.push(`Nombre: ${contact.displayName}`);
  if (contact.email) parts.push(`Email: ${contact.email}`);
  if (contact.phone) parts.push(`Teléfono: ${contact.phone}`);
  if (contact.totalOrders > 0) parts.push(`Pedidos anteriores: ${contact.totalOrders}`);
  if (contact.funnelStage) parts.push(`Etapa: ${contact.funnelStage}`);
  return parts.length > 0 ? parts.join(", ") : "Sin historial.";
}

// ==============================================
// PROCESAR MENSAJE CON GEMINI
// ==============================================
async function processWithGemini(messageText, contact, catalogInfo, orderInfo, conversationHistory) {
  const apiKey = geminiApiKey.value();

  if (!apiKey) {
    return {
      reply: "¡Hola! Gracias por escribirnos. Te atiendo en un momento. 😊",
      intent: "other",
      confidence: 0.3,
      needsHuman: true,
      suggestedProductIds: [],
    };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    // ⚠️ REGLA INQUEBRANTABLE: NO cambiar este modelo. Definido por el dueño del negocio.
    const GEMINI_MODEL = "gemini-2.5-flash-lite";
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 256,
      },
    });

    const contactContext = getContactContext(contact);

    let contextBlock = `CONTEXTO DEL CLIENTE: ${contactContext}`;
    if (orderInfo) contextBlock += `\n${orderInfo}`;
    contextBlock += `\nCATÁLOGO:\n${catalogInfo}`;

    // Construir historial como chat multi-turn
    const chatHistory = [];

    // Primer mensaje: contexto del sistema
    chatHistory.push({
      role: "user",
      parts: [{ text: `[CONTEXTO INTERNO - NO mencionar al cliente]\n${contextBlock}` }],
    });
    chatHistory.push({
      role: "model",
      parts: [{ text: "Entendido, tengo el contexto. Esperando mensaje del cliente." }],
    });

    // Agregar historial de conversación como mensajes reales
    if (conversationHistory) {
      const lines = conversationHistory.replace("HISTORIAL DE CONVERSACIÓN:\n", "").split("\n");
      for (const line of lines) {
        const match = line.match(/^\[(Cliente|Bot|Admin)\]: (.+)$/);
        if (match) {
          const [, who, content] = match;
          if (who === "Cliente") {
            chatHistory.push({ role: "user", parts: [{ text: content }] });
          } else {
            chatHistory.push({ role: "model", parts: [{ text: content }] });
          }
        }
      }

      // Reset de comportamiento: evitar que imite mensajes viejos
      chatHistory.push({
        role: "user",
        parts: [{ text: "[SISTEMA] Recordatorio: NO repitas saludos si ya saludaste. NO digas 'hola' ni 'mae' de nuevo. Respondé directo al punto. Seguí SOLO las instrucciones del system prompt, NO imites mensajes anteriores del bot." }],
      });
      chatHistory.push({
        role: "model",
        parts: [{ text: '{"reply": "Entendido, respondo directo sin saludar de nuevo.", "action": "reply", "orderData": null}' }],
      });
    }

    // Iniciar chat con historial
    const chat = model.startChat({ history: chatHistory });
    const result = await chat.sendMessage(messageText);
    const replyText = result.response.text().trim();
    console.log("Gemini reply:", replyText.substring(0, 200));

    // Parsear respuesta JSON de Gemini
    let parsed;
    try {
      // Limpiar posible markdown wrapping
      let cleanJson = replyText;
      if (cleanJson.startsWith("```")) {
        cleanJson = cleanJson.replace(/```json?\n?/g, "").replace(/```$/g, "").trim();
      }
      parsed = JSON.parse(cleanJson);
    } catch {
      // Si no devolvió JSON válido, tratar como texto plano
      console.log("Gemini no devolvió JSON, usando texto plano");
      parsed = { reply: replyText, action: "reply", orderData: null };
    }

    const reply = parsed.reply || replyText;
    const action = parsed.action || "reply";
    const orderData = parsed.orderData || null;

    // Detectar intención simple
    let intent = "other";
    const lower = messageText.toLowerCase();
    if (lower.match(/hola|hey|buenas/)) intent = "greeting";
    else if (lower.match(/precio|cuesta|cuánto|cuanto/)) intent = "price_check";
    else if (lower.match(/pedido|orden|estado|tracking/)) intent = "order_status";
    else if (lower.match(/comprar|quiero|pedir|ordenar/)) intent = "purchase";
    else if (lower.match(/pago|sinpe|transfer/)) intent = "payment_info";
    else if (lower.match(/queja|problema|devol/)) intent = "complaint";

    const needsHuman = action === "escalate" || intent === "complaint";

    return {
      reply,
      action,
      orderData,
      intent,
      confidence: 0.85,
      needsHuman: !!needsHuman,
      suggestedProductIds: [],
    };
  } catch (err) {
    console.error("Error calling Gemini:", err);
    return {
      reply: "¡Disculpá! Tuve un problemita. Te conecto con alguien del equipo. 🙏",
      action: "escalate",
      orderData: null,
      intent: "error",
      confidence: 0,
      needsHuman: true,
      suggestedProductIds: [],
    };
  }
}

// ==============================================
// ORQUESTADOR PRINCIPAL
// ==============================================
async function processInboundMessage(messageText, contact, { phone, contactId } = {}) {
  const { createChatOrder } = require("./chatOrder");

  const [catalogInfo, orderByNumber, ordersByPhone, ordersByName, convHistory] = await Promise.all([
    getCatalogContext(),
    getOrderContext(messageText),
    getOrdersByPhone(phone),
    getOrdersByCustomerInfo(contact),
    getConversationHistory(contactId),
  ]);

  // Combinar contexto de órdenes (deduplicar)
  const orderInfo = [orderByNumber, ordersByPhone, ordersByName].filter(Boolean).join("\n");
  const aiResult = await processWithGemini(messageText, contact, catalogInfo, orderInfo, convHistory);

  let reply = aiResult.reply;
  let orderCreated = null;

  // Procesar acciones
  if (aiResult.action === "create_order" && aiResult.orderData) {
    try {
      // Completar datos del contacto
      const orderPayload = {
        ...aiResult.orderData,
        customerPhone: aiResult.orderData.customerPhone || phone || contact?.phone || "",
        customerName: aiResult.orderData.customerName || contact?.displayName || "",
        customerEmail: contact?.email || "",
      };

      const result = await createChatOrder(contactId, orderPayload);
      if (result.success) {
        orderCreated = result;
        reply += `\n\n📦 Tu pedido ${result.orderNumber} está creado!\nTotal: ₡${result.total.toLocaleString()}\nHacé el SINPE al 7095-6070 y mandame el comprobante 😊`;
      } else {
        reply += `\n\nDiay, no pude crear el pedido: ${result.error}. Dejame pasar tu mensaje al equipo.`;
      }
    } catch (err) {
      console.error("Error creating order from chat:", err);
      reply += "\n\nHubo un problemita creando el pedido. Dejame pasarte con alguien del equipo.";
    }
  }

  if (aiResult.action === "escalate" && contactId) {
    try {
      await db.collection("crm_contacts").doc(contactId).update({
        unresolvedAttentionRequired: true,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("Error marking escalation:", err);
    }
  }

  return {
    type: aiResult.needsHuman ? "escalate" : "auto_reply",
    reply,
    intent: aiResult.intent,
    confidence: aiResult.confidence,
    suggestedProductIds: aiResult.suggestedProductIds,
    needsHumanReview: aiResult.needsHuman,
    orderCreated,
  };
}

module.exports = {
  processInboundMessage,
  processWithGemini,
  getCatalogContext,
  getContactContext,
  geminiApiKey,
};
