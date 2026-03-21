const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { db, FieldValue, notifyAdminsTelegram, logAutomation, logMessage, getAppConfig } = require("./utils");
const { findOrCreateContactByPhone, saveCrmMessage, updateCrmOnMessage } = require("./crm");
const { updateCrmOnCartAbandoned } = require("./crm");

const whatsappToken = defineSecret("WHATSAPP_TOKEN");
const whatsappPhoneId = defineSecret("WHATSAPP_PHONE_ID");
const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");
const telegramChatId = defineSecret("TELEGRAM_CHAT_ID");

// ==============================================
// HELPER: Enviar WhatsApp (interno, no callable)
// ==============================================
async function sendWhatsApp(to, message, { token, phoneId }) {
  if (!token || !phoneId) {
    console.log(`[WhatsApp STUB] To: ${to}, msg: ${message.substring(0, 60)}...`);
    return { status: "stub_logged", providerMessageId: "" };
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message },
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Error WhatsApp");

    return { status: "sent", providerMessageId: data.messages?.[0]?.id || "" };
  } catch (err) {
    return { status: "failed", error: err.message };
  }
}

// ==============================================
// HELPER: Construir mensaje desde plantilla + config
// ==============================================
function buildMessage(template, vars = {}) {
  let msg = template;
  for (const [key, val] of Object.entries(vars)) {
    msg = msg.replace(new RegExp(`\\{${key}\\}`, "g"), val || "");
  }
  return msg;
}

// ==============================================
// SCHEDULER: Procesar automatizaciones pendientes
// Ejecuta cada hora, busca pending con scheduledAt <= now
// ==============================================
exports.processScheduledAutomations = onSchedule(
  {
    schedule: "every 60 minutes",
    secrets: [whatsappToken, whatsappPhoneId, telegramBotToken, telegramChatId],
    timeoutSeconds: 300,
  },
  async () => {
    const config = await getAppConfig();
    const toggles = config.automationToggles || {};
    const templates = config.messageTemplates || {};
    const now = new Date().toISOString();

    const snap = await db.collection("automations")
      .where("status", "==", "pending")
      .where("scheduledAt", "<=", now)
      .limit(50)
      .get();

    if (snap.empty) {
      console.log("No pending automations.");
      return;
    }

    const token = whatsappToken.value();
    const phoneId = whatsappPhoneId.value();

    for (const doc of snap.docs) {
      const auto = doc.data();
      const autoRef = db.collection("automations").doc(doc.id);

      // Verificar que el tipo está habilitado
      const toggleKey = {
        carrito_abandonado: "cartAbandoned",
        review_request: "reviewRequest",
        backorder_payment: "backorderPayment",
        tracking_update: "trackingUpdate",
      }[auto.type];

      if (toggleKey && toggles[toggleKey] === false) {
        await autoRef.update({ status: "cancelled", updatedAt: now, result: "Toggle deshabilitado" });
        continue;
      }

      // Marcar como processing
      await autoRef.update({
        status: "processing",
        attemptCount: FieldValue.increment(1),
        updatedAt: now,
      });

      try {
        // Resolver teléfono del destinatario
        let phone = auto.metadata?.phone || "";
        let contactId = auto.targetContactId || "";

        if (!phone && auto.targetUid) {
          const crmSnap = await db.collection("crm_contacts").doc(auto.targetUid).get();
          if (crmSnap.exists) {
            phone = crmSnap.data().phone || "";
            contactId = contactId || auto.targetUid;
          }
        }

        if (!phone) {
          await autoRef.update({
            status: "failed",
            errorMessage: "No se encontró teléfono del destinatario",
            updatedAt: now,
          });
          continue;
        }

        // Construir mensaje según tipo
        let messageText = "";
        const name = auto.metadata?.customerName || auto.targetContact || "Cliente";
        const orderNumber = auto.metadata?.orderNumber || "";

        switch (auto.type) {
          case "carrito_abandonado":
            messageText = buildMessage(templates.cartAbandoned || "¡Hola {name}! 🛒 Tu carrito te espera.", { name });
            break;
          case "review_request":
            messageText = buildMessage(
              templates.reviewRequest || "¡Gracias {name}! 🌟 Déjanos tu reseña aquí: {reviewLink}",
              { name, reviewLink: config.reviewLink || "" }
            );
            break;
          case "backorder_payment":
            messageText = buildMessage(
              templates.backorderPayment || "¡Hola {name}! Tu pedido #{orderNumber} está listo. Saldo: ₡{remaining}",
              { name, orderNumber, remaining: auto.metadata?.remainingAmount || "" }
            );
            break;
          case "tracking_update":
            messageText = buildMessage(
              templates.trackingUpdate || "¡{name}! Pedido #{orderNumber} actualizado: {status}",
              { name, orderNumber, status: auto.metadata?.newStatus || "" }
            );
            break;
          default:
            messageText = auto.metadata?.customMessage || `Notificación de Aquí Pauli para ${name}`;
        }

        // Enviar por WhatsApp
        const result = await sendWhatsApp(phone, messageText, { token, phoneId });

        // Log global
        await logMessage({
          channel: "whatsapp",
          direction: "outbound",
          to: phone,
          content: messageText,
          relatedOrderId: auto.orderId || "",
          relatedContactUid: auto.targetUid || "",
          status: result.status,
          metadata: {
            automationId: doc.id,
            automationType: auto.type,
            providerMessageId: result.providerMessageId || "",
          },
        });

        // Guardar en CRM messages
        if (contactId) {
          await saveCrmMessage(contactId, {
            channel: "whatsapp",
            direction: "outbound",
            to: phone,
            content: messageText,
            status: result.status,
            providerMessageId: result.providerMessageId || "",
            automationId: doc.id,
            automationType: auto.type,
          });

          await updateCrmOnMessage(contactId, "outbound", "whatsapp");
        }

        // Actualizar automatización
        const finalStatus = result.status === "sent" || result.status === "stub_logged" ? "sent" : "failed";
        await autoRef.update({
          status: finalStatus,
          executedAt: now,
          result: result.status,
          errorMessage: result.error || "",
          updatedAt: now,
        });
      } catch (err) {
        console.error(`Error processing automation ${doc.id}:`, err);
        await autoRef.update({
          status: "failed",
          errorMessage: err.message,
          updatedAt: now,
        });
      }
    }

    console.log(`Processed ${snap.size} automations.`);
  }
);

// ==============================================
// SCHEDULER: Limpiar reservas de stock expiradas
// ==============================================
exports.cleanExpiredReservations = onSchedule(
  { schedule: "every day 00:00", timeoutSeconds: 120 },
  async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const snap = await db.collection("orders")
      .where("status", "==", "pendiente_pago")
      .where("createdAt", "<", todayStart)
      .get();

    if (snap.empty) {
      console.log("No expired reservations.");
      return;
    }

    for (const orderDoc of snap.docs) {
      const order = orderDoc.data();
      if (!order.reservedItems) continue;

      for (const item of order.reservedItems) {
        if (!item.variantId || !item.productId) continue;
        try {
          const varRef = db.collection("products").doc(item.productId).collection("variants").doc(item.variantId);
          await varRef.update({
            reservedStock: FieldValue.increment(-(item.quantity || 0)),
          });
        } catch (err) {
          console.error(`Error releasing stock for variant ${item.variantId}:`, err);
        }
      }

      await db.collection("orders").doc(orderDoc.id).update({
        status: "expirado",
        updatedAt: now.toISOString(),
      });

      console.log(`Order ${orderDoc.id} expired and stock released.`);
    }
  }
);

// ==============================================
// SCHEDULER: Carrito abandonado → crear automatización
// ==============================================
exports.processAbandonedCarts = onSchedule(
  { schedule: "every day 09:00", timeoutSeconds: 120 },
  async () => {
    const config = await getAppConfig();
    const hoursThreshold = config.cartAbandonmentHours || 24;
    const cutoff = new Date(Date.now() - hoursThreshold * 60 * 60 * 1000).toISOString();

    const snap = await db.collection("carts")
      .where("updatedAt", "<", cutoff)
      .where("notified", "!=", true)
      .limit(50)
      .get();

    if (snap.empty) {
      console.log("No abandoned carts.");
      return;
    }

    for (const cartDoc of snap.docs) {
      const cart = cartDoc.data();
      const uid = cartDoc.id;
      const itemCount = (cart.items || []).length;

      if (itemCount === 0) continue;

      // Actualizar CRM
      await updateCrmOnCartAbandoned(uid, itemCount);

      // Buscar teléfono del contacto
      let phone = "";
      let contactId = "";
      try {
        const crmSnap = await db.collection("crm_contacts").doc(uid).get();
        if (crmSnap.exists) {
          phone = crmSnap.data().phone || "";
          contactId = uid;
        }
      } catch (_) { /* ignore */ }

      // Solo crear automatización si hay teléfono
      if (phone) {
        const customerName = cart.customerName || "";
        await logAutomation({
          type: "carrito_abandonado",
          targetUid: uid,
          targetContact: customerName,
          targetContactId: contactId,
          channel: "whatsapp",
          metadata: { phone, customerName, itemCount },
        });
      }

      // Marcar como notificado
      await db.collection("carts").doc(uid).update({ notified: true });
    }

    console.log(`Processed ${snap.size} abandoned carts.`);
  }
);
