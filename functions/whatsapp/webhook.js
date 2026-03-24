// ==============================================
// WhatsApp Business API — Webhook
// Recibe mensajes (comprobantes de pago) y los procesa
// ==============================================
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const fetch = require("node-fetch");
const { extractPaymentData } = require("../ocr/paymentReader");
const { verifyWithGmail } = require("../gmail/verifier");
const { sendPaymentReceived, sendInteractiveButtons, sendInteractiveList, sendQuickConfirmation } = require("./sender");
const { transcribeAudio } = require("./audioTranscriber");
const { processWhatsAppOrder } = require("./processWhatsAppOrder");

const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");
const WHATSAPP_VERIFY_TOKEN = defineSecret("WHATSAPP_VERIFY_TOKEN");
const WHATSAPP_PHONE_ID = defineSecret("WHATSAPP_PHONE_ID");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const db = getFirestore();

/**
 * GET — Verificación del webhook (challenge de Meta)
 * POST — Recibe mensajes entrantes de WhatsApp
 */
const whatsappWebhook = onRequest(
  { secrets: [WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_PHONE_ID, GEMINI_API_KEY], cors: true, invoker: "public" },
  async (req, res) => {
    // --- GET: Verificación del webhook ---
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN.value()) {
        console.log("✅ Webhook verificado");
        return res.status(200).send(challenge);
      }
      return res.sendStatus(403);
    }

    // --- POST: Mensaje entrante ---
    if (req.method === "POST") {
      try {
        const body = req.body;
        const entry = body?.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const messages = value?.messages;

        if (!messages || messages.length === 0) {
          return res.sendStatus(200); // Evento sin mensajes (status updates, etc.)
        }

        for (const message of messages) {
          const from = message.from; // Teléfono del remitente (formato: 506XXXXXXXX)
          const phoneClean = normalizePhone(from);

          console.log(`📱 Mensaje de ${phoneClean}, tipo: ${message.type}`);

          if (message.type === "image" || message.type === "document") {
            await processPaymentProof(message, phoneClean);
          } else if (message.type === "audio") {
            await processAudioMessage(message, phoneClean);
          } else if (message.type === "order") {
            await processOrderMessage(message, phoneClean);
          } else if (message.type === "text") {
            // Podría ser un número de orden o mensaje de seguimiento
            await processTextMessage(message, phoneClean);
          } else if (message.type === "interactive") {
            // Respuesta de botón interactivo o lista
            await processInteractiveReply(message, phoneClean);
          }
        }
      } catch (error) {
        console.error("❌ Error procesando webhook:", error);
      }

      return res.sendStatus(200);
    }

    return res.sendStatus(405);
  }
);

/**
 * Procesa imagen/documento de comprobante de pago
 */
async function processPaymentProof(message, phone) {
  const mediaId = message.image?.id || message.document?.id;
  if (!mediaId) return;

  try {
    // 1. Descargar media de WhatsApp
    const mediaUrl = await getMediaUrl(mediaId);
    const mediaBuffer = await downloadMedia(mediaUrl);

    // 2. Subir a Firebase Storage
    const timestamp = Date.now();
    const fileName = `payment-proofs/${phone}_${timestamp}.jpg`;
    const bucket = getStorage().bucket();
    const file = bucket.file(fileName);
    await file.save(mediaBuffer, { metadata: { contentType: "image/jpeg" } });
    await file.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

    console.log(`📸 Imagen guardada: ${publicUrl}`);

    // 3. OCR — Extraer datos del comprobante
    let ocrData = null;
    try {
      ocrData = await extractPaymentData(publicUrl);
      console.log("🔍 OCR data:", JSON.stringify(ocrData));
    } catch (ocrErr) {
      console.error("⚠️ OCR falló, continuar sin datos:", ocrErr.message);
    }

    // 4. Buscar orden pendiente de este teléfono
    let order = null;
    try {
      order = await findPendingOrder(phone, ocrData?.amount);
    } catch (findErr) {
      console.error("⚠️ Error buscando orden:", findErr.message);
    }

    if (order) {
      // Clasificar tipo de pago del comprobante
      const paymentType = ocrData?.bank === 'SINPE' || 
        (ocrData?.rawText || '').toUpperCase().includes('SINPE') ? 'sinpe' : 'transferencia';
      
      console.log(`💳 Tipo de pago detectado: ${paymentType}`);

      if (paymentType === 'sinpe') {
        // SINPE Móvil → Revisión humana (el banco NO envía email)
        await db.collection("orders").doc(order.id).update({
          paymentProofUrl: publicUrl,
          paymentStatus: "revision_humana",
          paymentType: "sinpe",
          ocrData: ocrData || {},
          whatsappPhone: phone,
          proofReceivedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        console.log(`👁️ Orden ${order.orderNumber}: SINPE → revisión humana`);
        await sendPaymentReceived(phone, order.orderNumber);
      } else {
        // Transferencia bancaria → Verificación automática vía Gmail
        await db.collection("orders").doc(order.id).update({
          paymentProofUrl: publicUrl,
          paymentStatus: "verificando",
          paymentType: "transferencia",
          ocrData: ocrData || {},
          whatsappPhone: phone,
          proofReceivedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        console.log(`🏦 Orden ${order.orderNumber}: Transferencia → verificando con Gmail`);

        // Intentar verificación con Gmail
        if (ocrData?.transactionId || ocrData?.amount) {
          try {
            await verifyWithGmail(order.id, ocrData);
          } catch (gmailErr) {
            console.error("⚠️ Gmail verification falló:", gmailErr.message);
          }
        }
        await sendPaymentReceived(phone, order.orderNumber);
      }
    } else {
      // No encontramos orden — guardar como comprobante huérfano
      await db.collection("orphan_proofs").add({
        phone,
        imageUrl: publicUrl,
        ocrData: ocrData || {},
        receivedAt: new Date().toISOString(),
        status: "sin_orden",
      });
      console.log(`⚠️ Comprobante sin orden asociada para ${phone}`);
      
      // Responder al usuario que recibimos su comprobante
      await sendWhatsAppMessage(phone, 
        "📸 ¡Recibimos tu comprobante! Nuestro equipo lo va a revisar. " +
        "Si tenés un número de pedido (AP-XXXXXX), envialo por este chat para vincularlo más rápido. 😊"
      );
    }
  } catch (error) {
    console.error("❌ Error procesando comprobante:", error);
    // Aún así intentar notificar al usuario
    try {
      await sendWhatsAppMessage(phone, 
        "📸 Recibimos tu imagen. Hubo un problema procesándola pero nuestro equipo la va a revisar. ¡Gracias por tu paciencia! 😊"
      );
    } catch (msgErr) {
      console.error("❌ No se pudo enviar respuesta:", msgErr.message);
    }
  }
}

/**
 * Procesa mensajes de texto (podría ser número de orden)
 */
async function processTextMessage(message, phone) {
  let text = (message.text?.body || "").trim();
  const textUpper = text.toUpperCase();

  // ── Detectar producto referenciado del catálogo de WhatsApp ──
  // Cuando el cliente toca un producto del catálogo y escribe un mensaje,
  // WhatsApp incluye context.referred_product con el ID del producto
  const referredProduct = message.context?.referred_product;
  if (referredProduct) {
    const retailerId = referredProduct.catalog_id
      ? referredProduct.catalog_id
      : null;
    const productId = referredProduct.product_retailer_id || null;
    console.log(`📦 Producto referenciado: retailerId=${productId}, catalogId=${retailerId}`);

    if (productId) {
      try {
        // Resolver el ID compuesto (productId_variantId)
        let realProductId = productId;
        let variantId = null;
        let productDoc = await db.collection("products").doc(productId).get();

        if (!productDoc.exists) {
          const underscoreIdx = productId.indexOf("_");
          if (underscoreIdx > 0) {
            realProductId = productId.substring(0, underscoreIdx);
            variantId = productId.substring(underscoreIdx + 1);
            productDoc = await db.collection("products").doc(realProductId).get();
          }
        }

        if (productDoc.exists) {
          const pData = productDoc.data();
          let productInfo = `[PRODUCTO REFERENCIADO: ${pData.name} — ₡${(pData.basePrice || 0).toLocaleString("es-CR")}]`;

          // Buscar variante si aplica
          if (variantId) {
            const vDoc = await db.collection("products").doc(realProductId)
              .collection("variants").doc(variantId).get();
            if (vDoc.exists) {
              const vData = vDoc.data();
              productInfo = `[PRODUCTO REFERENCIADO: ${pData.name} - ${vData.name || variantId} — ₡${(vData.price || pData.basePrice || 0).toLocaleString("es-CR")}, stock: ${vData.stock || 0}, tipo: ${pData.supplyType || "normal"}]`;
            }
          }

          // Enriquecer el texto con el contexto del producto
          text = `${productInfo} ${text}`;
          console.log(`📦 Texto enriquecido: "${text.substring(0, 150)}..."`);
        }
      } catch (err) {
        console.warn(`⚠️ Error resolviendo producto referenciado:`, err.message);
      }
    }
  }

  // Si parece un número de orden (AP-XXXXXX-XXXX)
  if (textUpper.startsWith("AP-")) {
    const orderSnap = await db.collection("orders")
      .where("orderNumber", "==", textUpper)
      .limit(1)
      .get();

    if (!orderSnap.empty) {
      const order = orderSnap.docs[0];
      await order.ref.update({ whatsappPhone: phone });
    }
  }

  // Buscar o crear contacto CRM
  let contactId = null;
  let contact = null;
  const phoneVariants = getPhoneVariants(phone);

  for (const pv of phoneVariants) {
    const snap = await db.collection("crm_contacts")
      .where("phone", "==", pv)
      .limit(1)
      .get();
    if (!snap.empty) {
      contactId = snap.docs[0].id;
      contact = snap.docs[0].data();
      break;
    }
  }

  if (!contactId) {
    // Crear contacto nuevo
    const newRef = db.collection("crm_contacts").doc();
    contactId = newRef.id;
    contact = {
      phone,
      displayName: "",
      funnelStage: "interesado",
      lastChannel: "whatsapp",
      totalOrders: 0,
      totalSpent: 0,
      createdAt: new Date().toISOString(),
    };
    await newRef.set(contact);
  }

  // Guardar mensaje entrante
  const isTranscribed = message._isTranscribed || false;
  await db.collection("crm_contacts").doc(contactId).collection("messages").add({
    content: isTranscribed ? `🎤 ${text}` : text,
    direction: "inbound",
    channel: "whatsapp",
    phone,
    autoReply: false,
    isAudioTranscription: isTranscribed,
    createdAt: new Date().toISOString(),
  });

  // Actualizar contacto
  await db.collection("crm_contacts").doc(contactId).update({
    lastChannel: "whatsapp",
    lastMessageAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Procesar con IA
  try {
    const { processInboundMessage } = require("../conversation");
    const aiResult = await processInboundMessage(text, contact, { phone, contactId });

    console.log("AI result:", aiResult.type, "intent:", aiResult.intent);

    if (aiResult.reply) {
      // Decidir si enviar con botones o como texto plano
      if (aiResult.buttons && aiResult.buttons.length > 0 && aiResult.buttons.length <= 3) {
        // Enviar con botones interactivos
        await sendInteractiveButtons(phone, aiResult.reply, aiResult.buttons, null, "Aquí Pauli");
      } else if (aiResult.buttons && aiResult.buttons.length > 3) {
        // Enviar como lista interactiva
        await sendInteractiveList(phone, aiResult.reply, "Ver opciones", [{
          title: "Opciones",
          rows: aiResult.buttons.slice(0, 10).map(b => ({
            id: b.id || b.title,
            title: b.title,
            description: b.description || "",
          })),
        }], null, "Aquí Pauli");
      } else {
        // Texto plano normal (con delay natural integrado en sendWhatsAppMessage)
        await sendWhatsAppMessage(phone, aiResult.reply);
      }

      // Guardar respuesta del bot
      await db.collection("crm_contacts").doc(contactId).collection("messages").add({
        content: aiResult.reply,
        direction: "outbound",
        channel: "whatsapp",
        autoReply: true,
        intent: aiResult.intent,
        hasButtons: !!(aiResult.buttons && aiResult.buttons.length > 0),
        createdAt: new Date().toISOString(),
      });
    }

    // Si se escaló, marcar contacto
    if (aiResult.needsHumanReview) {
      await db.collection("crm_contacts").doc(contactId).update({
        unresolvedAttentionRequired: true,
        lastIntent: aiResult.intent,
      });
    }
  } catch (aiErr) {
    console.error("Error en IA:", aiErr);
  }
}

/**
 * Procesa respuestas de botones interactivos y listas de WhatsApp
 */
async function processInteractiveReply(message, phone) {
  const interactive = message.interactive;
  if (!interactive) return;

  let replyText = "";
  let replyId = "";

  if (interactive.type === "button_reply") {
    // Respuesta de botón (máx 3 opciones)
    replyId = interactive.button_reply?.id || "";
    replyText = interactive.button_reply?.title || replyId;
    console.log(`🔘 Botón presionado: id="${replyId}", title="${replyText}"`);
  } else if (interactive.type === "list_reply") {
    // Respuesta de lista desplegable
    replyId = interactive.list_reply?.id || "";
    replyText = interactive.list_reply?.title || replyId;
    console.log(`📋 Lista seleccionada: id="${replyId}", title="${replyText}"`);
  }

  if (!replyText) return;

  // ── Manejo especial: botón "Pedir en Web" ──
  if (replyId === "order_web") {
    const webMsg =
      "🌐 *¡Pedí desde nuestra tienda online!*\n\n" +
      "Podés ver todos los productos, elegir tallas y colores, y hacer tu pedido directamente 👇\n\n" +
      "🛒 https://aqui-pauli.web.app/tienda\n\n" +
      "Si necesitás ayuda con algo, escribime por acá 😊";

    await sendWhatsAppMessage(phone, webMsg);

    // Guardar en historial del CRM
    const phoneVariants = getPhoneVariants(phone);
    for (const pv of phoneVariants) {
      const snap = await db.collection("crm_contacts").where("phone", "==", pv).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.collection("messages").add({
          content: "🔘 [Botón: Pedir en Web]",
          direction: "inbound",
          channel: "whatsapp",
          phone,
          autoReply: false,
          createdAt: new Date().toISOString(),
        });
        await snap.docs[0].ref.collection("messages").add({
          content: webMsg,
          direction: "outbound",
          channel: "whatsapp",
          autoReply: true,
          createdAt: new Date().toISOString(),
        });
        break;
      }
    }
    return;
  }

  // ── Manejo especial: botón "Ver Catálogo" ──
  if (replyId === "view_catalog") {
    const catalogMsg =
      "🛍️ *¡Explorá nuestro catálogo!*\n\n" +
      "Acá podés ver todos nuestros productos con fotos y precios 👇\n\n" +
      "📋 https://wa.me/c/50670956070\n\n" +
      "Cuando encontrés algo que te guste, agregalo al carrito desde ahí o escribime el nombre del producto y te ayudo con tallas y disponibilidad 😊";

    await sendWhatsAppMessage(phone, catalogMsg);

    // Guardar en historial del CRM
    const phoneVariants = getPhoneVariants(phone);
    for (const pv of phoneVariants) {
      const snap = await db.collection("crm_contacts").where("phone", "==", pv).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.collection("messages").add({
          content: "🔘 [Botón: Ver Catálogo]",
          direction: "inbound",
          channel: "whatsapp",
          phone,
          autoReply: false,
          createdAt: new Date().toISOString(),
        });
        await snap.docs[0].ref.collection("messages").add({
          content: catalogMsg,
          direction: "outbound",
          channel: "whatsapp",
          autoReply: true,
          createdAt: new Date().toISOString(),
        });
        break;
      }
    }
    return;
  }

  // Procesar como mensaje de texto normal con metadata extra
  const virtualMessage = {
    text: { body: replyText },
    type: "text",
    _isInteractiveReply: true,
    _interactiveId: replyId,
    _interactiveType: interactive.type,
  };

  await processTextMessage(virtualMessage, phone);
}

/**
 * Procesa notas de voz / audios de WhatsApp
 * Descarga → Transcribe con Gemini → Procesa como texto
 */
async function processAudioMessage(message, phone) {
  const mediaId = message.audio?.id;
  if (!mediaId) return;

  const mimeType = message.audio?.mime_type || "audio/ogg";
  console.log(`🎤 Audio recibido de ${phone}, mime: ${mimeType}, id: ${mediaId}`);

  try {
    // 1. Descargar audio de WhatsApp
    const mediaUrl = await getMediaUrl(mediaId);
    const audioBuffer = await downloadMedia(mediaUrl);
    console.log(`🎤 Audio descargado: ${audioBuffer.length} bytes`);

    // 2. Transcribir con Gemini
    const transcription = await transcribeAudio(audioBuffer, mimeType);

    if (!transcription || transcription === "[audio vacío]") {
      await sendWhatsAppMessage(phone,
        "🎤 Recibí tu audio pero no logré entender lo que decís. ¿Podrías repetirlo o escribirme? 😊"
      );
      return;
    }

    console.log(`🎤 Transcripción: "${transcription.substring(0, 100)}..."`);

    // 3. Procesar como mensaje de texto normal
    // Creamos un mensaje virtual con el texto transcrito
    const virtualMessage = {
      text: { body: transcription },
      type: "text",
      _isTranscribed: true,
      _originalType: "audio",
    };

    await processTextMessage(virtualMessage, phone);

  } catch (err) {
    console.error("❌ Error procesando audio:", err);
    await sendWhatsAppMessage(phone,
      "🎤 Recibí tu nota de voz pero tuve un problemita procesándola. ¿Podrías escribirme tu mensaje? 😊"
    );
  }
}

/**
 * Procesa carrito enviado desde el catálogo nativo de WhatsApp
 */
async function processOrderMessage(message, phone) {
  console.log(`🛒 Carrito WA recibido de ${phone}`);

  try {
    // Buscar o crear contacto CRM
    let contactId = null;
    let contact = null;
    const phoneVariants = getPhoneVariants(phone);

    for (const pv of phoneVariants) {
      const snap = await db.collection("crm_contacts")
        .where("phone", "==", pv)
        .limit(1)
        .get();
      if (!snap.empty) {
        contactId = snap.docs[0].id;
        contact = snap.docs[0].data();
        break;
      }
    }

    if (!contactId) {
      const newRef = db.collection("crm_contacts").doc();
      contactId = newRef.id;
      contact = {
        phone,
        displayName: "",
        funnelStage: "comprador",
        lastChannel: "whatsapp",
        totalOrders: 0,
        createdAt: new Date().toISOString(),
      };
      await newRef.set(contact);
    }

    // Procesar el carrito
    const result = await processWhatsAppOrder(message, phone, contactId, contact);

    if (result.success) {
      // Confirmación con datos de pago
      const itemsList = result.items.map(i =>
        `• ${i.productName} x${i.quantity} — ₡${i.price.toLocaleString()}`
      ).join('\n');

      let reply = `✅ *¡Pedido confirmado!*\n\n` +
        `🔖 *Número:* ${result.orderNumber}\n\n` +
        `📦 *Productos:*\n${itemsList}\n\n` +
        `🚚 *Envío:* ₡${result.shippingCost.toLocaleString()}\n` +
        `💰 *Total:* ₡${result.total.toLocaleString()}\n\n` +
        `💳 *Pago:* SINPE Móvil / Transferencia\n` +
        `📱 *SINPE:* 7095-6070\n` +
        `🏦 *IBAN:* CR15081400011020004961\n\n` +
        `Enviame el comprobante cuando lo hagás 😊🎉`;

      if (result.stockWarnings) {
        reply += `\n\n⚠️ *Nota:* ${result.stockWarnings.join(". ")}`;
      }

      await sendWhatsAppMessage(phone, reply);

      // Guardar en historial
      await db.collection("crm_contacts").doc(contactId).collection("messages").add({
        content: `🛒 Carrito WA: ${result.orderNumber}`,
        direction: "inbound",
        channel: "whatsapp",
        phone,
        isCartOrder: true,
        autoReply: false,
        createdAt: new Date().toISOString(),
      });
      await db.collection("crm_contacts").doc(contactId).collection("messages").add({
        content: reply,
        direction: "outbound",
        channel: "whatsapp",
        autoReply: true,
        createdAt: new Date().toISOString(),
      });
    } else {
      await sendWhatsAppMessage(phone,
        `😔 ${result.error || "No pudimos procesar tu carrito"}. ¿Podrías intentar de nuevo o escribirnos qué necesitás? 😊`
      );
    }

    // Actualizar contacto
    await db.collection("crm_contacts").doc(contactId).update({
      lastChannel: "whatsapp",
      funnelStage: "comprador",
      lastMessageAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Error procesando carrito WA:", err);
    await sendWhatsAppMessage(phone,
      "Recibí tu carrito pero tuve un problemita procesándolo. Nuestro equipo te va a contactar. 🙏"
    );
  }
}

/**
 * Envía mensaje de texto por WhatsApp
 */
async function sendWhatsAppMessage(to, text) {
  try {
    const token = WHATSAPP_TOKEN.value().replace(/^Bearer\s+/i, '').trim();
    const phoneId = WHATSAPP_PHONE_ID.value().trim();
    console.log(`📤 Enviando WA a ${to} via phoneId=${phoneId}, texto="${text.substring(0, 50)}..."`);
    const url = `https://graph.facebook.com/v22.0/${phoneId}/messages`;
    const body = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    console.log(`📤 WA API status=${resp.status}, response:`, JSON.stringify(data));
    if (data.error) {
      console.error("❌ Error enviando WhatsApp:", JSON.stringify(data.error));
    } else {
      console.log("✅ Mensaje enviado OK, messageId:", data.messages?.[0]?.id);
    }
  } catch (err) {
    console.error("❌ Error enviando WhatsApp:", err.message || err);
  }
}

/**
 * Busca orden pendiente de pago por teléfono del cliente
 */
async function findPendingOrder(phone, ocrAmount) {
  // Buscar por teléfono en varios campos
  const phoneVariants = getPhoneVariants(phone);

  for (const phoneVar of phoneVariants) {
    // Buscar por customerPhone
    let snap = await db.collection("orders")
      .where("customerPhone", "==", phoneVar)
      .where("paymentStatus", "in", ["pendiente", "verificando"])
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();

    if (snap.empty) {
      // Buscar por paymentPhone (SINPE)
      try {
        snap = await db.collection("orders")
          .where("paymentPhone", "==", phoneVar)
          .where("paymentStatus", "in", ["pendiente", "verificando"])
          .orderBy("createdAt", "desc")
          .limit(5)
          .get();
      } catch (e) {
        console.warn("⚠️ Query paymentPhone falló (posible índice faltante):", e.message);
      }
    }

    if (!snap.empty) {
      // Si tenemos monto del OCR, intentar hacer match exacto
      if (ocrAmount) {
        const exactMatch = snap.docs.find(d => {
          const orderTotal = d.data().total || ((d.data().depositTotal || 0) + (d.data().remainingTotal || 0) + (d.data().shippingCost || 0));
          return Math.abs(orderTotal - ocrAmount) < 100; // Tolerancia de ₡100
        });
        if (exactMatch) return { id: exactMatch.id, ...exactMatch.data() };
      }
      // Retornar la más reciente
      const doc = snap.docs[0];
      return { id: doc.id, ...doc.data() };
    }
  }

  return null;
}

/**
 * Obtiene variantes del teléfono para búsqueda flexible
 * ej: "50688888888" → ["88888888", "8888-8888", "50688888888", "+50688888888"]
 */
function getPhoneVariants(phone) {
  const clean = phone.replace(/\D/g, "");
  const variants = [clean];

  // Sin código de país
  if (clean.startsWith("506")) {
    const local = clean.slice(3);
    variants.push(local);
    variants.push(local.slice(0, 4) + "-" + local.slice(4));
  }

  // Con +
  variants.push("+" + clean);
  if (!clean.startsWith("506")) {
    variants.push("506" + clean);
    variants.push("+506" + clean);
  }

  return [...new Set(variants)];
}

function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

/**
 * Obtiene el token limpio (sin prefijo Bearer duplicado)
 */
function getCleanToken() {
  const raw = WHATSAPP_TOKEN.value();
  return raw.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Obtiene URL de descarga de media de WhatsApp
 */
async function getMediaUrl(mediaId) {
  const resp = await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${getCleanToken()}` },
  });
  const data = await resp.json();
  return data.url;
}

/**
 * Descarga el archivo de media
 */
async function downloadMedia(url) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${getCleanToken()}` },
  });
  return resp.buffer();
}

module.exports = { whatsappWebhook };
