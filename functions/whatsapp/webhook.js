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
const { sendPaymentReceived } = require("./sender");

const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");
const WHATSAPP_VERIFY_TOKEN = defineSecret("WHATSAPP_VERIFY_TOKEN");
const WHATSAPP_PHONE_ID = defineSecret("WHATSAPP_PHONE_ID");

const db = getFirestore();

/**
 * GET — Verificación del webhook (challenge de Meta)
 * POST — Recibe mensajes entrantes de WhatsApp
 */
const whatsappWebhook = onRequest(
  { secrets: [WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_PHONE_ID], cors: true },
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
          } else if (message.type === "text") {
            // Podría ser un número de orden o mensaje de seguimiento
            await processTextMessage(message, phoneClean);
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
    const order = await findPendingOrder(phone, ocrData?.amount);

    if (order) {
      // 5. Actualizar la orden con el comprobante
      await db.collection("orders").doc(order.id).update({
        paymentProofUrl: publicUrl,
        paymentStatus: "verificando",
        ocrData: ocrData || {},
        whatsappPhone: phone,
        proofReceivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      console.log(`✅ Orden ${order.orderNumber} actualizada con comprobante`);

      // 6. Disparar verificación Gmail (si tenemos # transacción)
      if (ocrData?.transactionId) {
        try {
          await verifyWithGmail(order.id, ocrData);
        } catch (gmailErr) {
          console.error("⚠️ Gmail verification falló:", gmailErr.message);
          // No es crítico, el admin puede verificar manualmente
        }
      }

      // 7. Responder al cliente
      await sendPaymentReceived(phone, order.orderNumber);
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
    }
  } catch (error) {
    console.error("❌ Error procesando comprobante:", error);
  }
}

/**
 * Procesa mensajes de texto (podría ser número de orden)
 */
async function processTextMessage(message, phone) {
  const text = (message.text?.body || "").trim().toUpperCase();

  // Si parece un número de orden (AP-XXXXXX-XXXX)
  if (text.startsWith("AP-")) {
    const orderSnap = await db.collection("orders")
      .where("orderNumber", "==", text)
      .limit(1)
      .get();

    if (!orderSnap.empty) {
      const order = orderSnap.docs[0];
      // Actualizar teléfono de WhatsApp en la orden
      await order.ref.update({ whatsappPhone: phone });
    }
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
      snap = await db.collection("orders")
        .where("paymentPhone", "==", phoneVar)
        .where("paymentStatus", "in", ["pendiente", "verificando"])
        .orderBy("createdAt", "desc")
        .limit(5)
        .get();
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
 * Obtiene URL de descarga de media de WhatsApp
 */
async function getMediaUrl(mediaId) {
  const resp = await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN.value()}` },
  });
  const data = await resp.json();
  return data.url;
}

/**
 * Descarga el archivo de media
 */
async function downloadMedia(url) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN.value()}` },
  });
  return resp.buffer();
}

module.exports = { whatsappWebhook };
