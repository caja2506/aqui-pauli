const { defineSecret } = require("firebase-functions/params");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { db } = require("./utils");

const geminiApiKey = defineSecret("GEMINI_API_KEY");

// ==============================================
// SYSTEM PROMPT PARA GEMINI
// ==============================================
const SYSTEM_PROMPT = `Sos el asistente virtual de Aquí Pauli, una tienda online de ropa, calzado y accesorios en Costa Rica.

PERSONALIDAD:
- Amable, casual y tica (usá "mae", "tuanis", "pura vida" naturalmente)
- Eficiente: respondé directo sin rodeos
- Profesional pero cercana

CAPACIDADES:
- Consultar precios y disponibilidad de productos del catálogo
- Informar sobre estado de pedidos (si se proporciona la info)
- Explicar métodos de pago: SINPE Móvil, transferencia bancaria, PayPal
- Indicar que hacemos envíos a todo Costa Rica
- Recibir comprobantes de pago
- Nuestro WhatsApp Business: +506 7095-6070

REGLAS:
1. Si no podés resolver algo (quejas, devoluciones, problemas técnicos), decí que vas a escalar a un humano
2. NUNCA inventes datos que no estén en el contexto proporcionado
3. Si no tenés info, decí "dejame consultar con el equipo y te aviso"
4. Respondé SIEMPRE en español costarricense
5. Respuestas CORTAS: máximo 2-3 oraciones para WhatsApp/Telegram
6. NO uses formato JSON, ni código, ni markdown. Solo texto natural.`;

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
// BUSCAR ORDEN POR NÚMERO
// ==============================================
async function getOrderContext(messageText) {
  // Detectar patrones de número de orden como AP-XXXXXX
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
    const statusLabels = {
      pendiente_pago: "Pendiente de pago",
      pagado: "Pagado",
      preparando: "En preparación",
      enviado: "Enviado",
      entregado: "Entregado",
      cancelado: "Cancelado",
    };

    return `ORDEN ${orderNumber}: Estado=${statusLabels[order.status] || order.status}, Total=₡${order.total}, Pago=${order.paymentMethod}, Cliente=${order.customerName}, Fecha=${order.createdAt?.substring(0, 10) || "N/A"}`;
  } catch (err) {
    console.error("Error getting order:", err);
    return "";
  }
}

// ==============================================
// CONTEXTO DEL CONTACTO CRM
// ==============================================
function getContactContext(contact) {
  if (!contact) return "Cliente nuevo.";
  const parts = [];
  if (contact.displayName) parts.push(`Nombre: ${contact.displayName}`);
  if (contact.totalOrders > 0) parts.push(`Pedidos anteriores: ${contact.totalOrders}`);
  return parts.length > 0 ? parts.join(", ") : "Sin historial.";
}

// ==============================================
// PROCESAR MENSAJE CON GEMINI
// ==============================================
async function processWithGemini(messageText, contact, catalogInfo, orderInfo) {
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
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 256,
      },
    });

    const contactContext = getContactContext(contact);

    let contextBlock = `CLIENTE: ${contactContext}`;
    if (orderInfo) contextBlock += `\n${orderInfo}`;
    contextBlock += `\nCATÁLOGO:\n${catalogInfo}`;

    const prompt = `${SYSTEM_PROMPT}

${contextBlock}

MENSAJE: "${messageText}"

Respondé DIRECTAMENTE al cliente. Solo texto natural, sin JSON, sin formato.`;

    const result = await model.generateContent(prompt);
    const replyText = result.response.text().trim();
    console.log("Gemini reply:", replyText.substring(0, 200));

    // Detectar intención simple
    let intent = "other";
    const lower = messageText.toLowerCase();
    if (lower.match(/hola|hey|buenas/)) intent = "greeting";
    else if (lower.match(/precio|cuesta|cuánto|cuanto/)) intent = "price_check";
    else if (lower.match(/pedido|orden|estado|tracking/)) intent = "order_status";
    else if (lower.match(/envío|envio|envíos/)) intent = "shipping";
    else if (lower.match(/pago|sinpe|transfer/)) intent = "payment_info";
    else if (lower.match(/gracias|thanks/)) intent = "thanks";
    else if (lower.match(/producto|catálogo|catalogo|tienen/)) intent = "product_inquiry";
    else if (lower.match(/queja|problema|devol/)) intent = "complaint";

    const needsHuman = intent === "complaint" || lower.match(/humano|persona|encargado/);

    return {
      reply: replyText,
      intent,
      confidence: 0.85,
      needsHuman: !!needsHuman,
      suggestedProductIds: [],
    };
  } catch (err) {
    console.error("Error calling Gemini:", err);
    return {
      reply: "¡Disculpá! Tuve un problemita. Te conecto con alguien del equipo. 🙏",
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
async function processInboundMessage(messageText, contact) {
  const catalogInfo = await getCatalogContext();
  const orderInfo = await getOrderContext(messageText);
  const aiResult = await processWithGemini(messageText, contact, catalogInfo, orderInfo);

  return {
    type: aiResult.needsHuman ? "escalate" : "auto_reply",
    reply: aiResult.reply,
    intent: aiResult.intent,
    confidence: aiResult.confidence,
    suggestedProductIds: aiResult.suggestedProductIds,
    needsHumanReview: aiResult.needsHuman,
  };
}

module.exports = {
  processInboundMessage,
  processWithGemini,
  getCatalogContext,
  getContactContext,
  geminiApiKey,
};
