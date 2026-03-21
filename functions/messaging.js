const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { db, notifyAdminsTelegram, logMessage } = require("./utils");
const {
  findOrCreateContactByPhone,
  saveCrmMessage,
  updateCrmOnMessage,
} = require("./crm");
const { processInboundMessage, geminiApiKey } = require("./conversation");

const whatsappToken = defineSecret("WHATSAPP_TOKEN");
const whatsappPhoneId = defineSecret("WHATSAPP_PHONE_ID");
const whatsappVerifyToken = defineSecret("WHATSAPP_VERIFY_TOKEN");
const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");
const telegramChatId = defineSecret("TELEGRAM_CHAT_ID");

// ==============================================
// WHATSAPP: Envío de mensaje (callable)
// Ahora guarda también en crm_contacts/{id}/messages/
// ==============================================
exports.sendWhatsAppMessage = onCall(
  { secrets: [whatsappToken, whatsappPhoneId], invoker: "public", cors: true },
  async (request) => {
    const { to, message, relatedOrderId, relatedContactUid } = request.data;

    if (!to || !message) {
      throw new HttpsError("invalid-argument", "to y message requeridos.");
    }

    const token = whatsappToken.value();
    const phoneId = whatsappPhoneId.value();
    let providerMessageId = "";
    let status = "stub_logged";

    if (!token || !phoneId) {
      console.log(`[WhatsApp STUB] To: ${to}, Message: ${message}`);
    } else {
      try {
        const response = await fetch(
          `https://graph.facebook.com/v18.0/${phoneId}/messages`,
          {
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
          }
        );

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error?.message || "Error WhatsApp");
        }
        providerMessageId = data.messages?.[0]?.id || "";
        status = "sent";
      } catch (err) {
        status = "failed";
        // Log global
        await logMessage({
          channel: "whatsapp",
          direction: "outbound",
          to,
          content: message,
          relatedOrderId: relatedOrderId || "",
          relatedContactUid: relatedContactUid || "",
          status: "failed",
          metadata: { error: err.message },
        });
        throw new HttpsError("internal", err.message);
      }
    }

    // Log global en message_logs
    await logMessage({
      channel: "whatsapp",
      direction: "outbound",
      to,
      content: message,
      relatedOrderId: relatedOrderId || "",
      relatedContactUid: relatedContactUid || "",
      status,
      metadata: { providerMessageId },
    });

    // Guardar en CRM del contacto
    let contactId = relatedContactUid || null;
    if (!contactId) {
      const { contactId: found } = await findOrCreateContactByPhone(to);
      contactId = found;
    }

    if (contactId) {
      await saveCrmMessage(contactId, {
        channel: "whatsapp",
        direction: "outbound",
        to,
        content: message,
        status,
        providerMessageId,
        relatedOrderId: relatedOrderId || "",
      });

      await updateCrmOnMessage(contactId, "outbound", "whatsapp");
    }

    return { status, messageId: providerMessageId };
  }
);

// ==============================================
// WHATSAPP: Webhook para mensajes entrantes
// Guarda en message_logs + crm_contacts/{id}/messages/
// ==============================================
exports.whatsappWebhook = onRequest(
  { secrets: [whatsappToken, whatsappPhoneId, whatsappVerifyToken, telegramBotToken, telegramChatId, geminiApiKey] },
  async (req, res) => {
    // ── Verificación del webhook (GET) ──
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      const verifyToken = whatsappVerifyToken.value();
      if (mode === "subscribe" && token === verifyToken) {
        console.log("WhatsApp webhook verified.");
        return res.status(200).send(challenge);
      }
      return res.status(403).send("Forbidden");
    }

    // ── Recepción de mensajes (POST) ──
    if (req.method === "POST") {
      try {
        const entries = req.body?.entry || [];
        for (const entry of entries) {
          const changes = entry?.changes || [];
          for (const change of changes) {
            const messages = change?.value?.messages || [];
            const contacts = change?.value?.contacts || [];

            for (const msg of messages) {
              const from = msg.from;
              const msgType = msg.type;
              const text = msg.text?.body || "";
              const timestamp = msg.timestamp;
              const contactName = contacts.find(c => c.wa_id === from)?.profile?.name || "";

              // 1. Buscar o crear contacto CRM
              const { contactId, isNew } = await findOrCreateContactByPhone(from, {
                displayName: contactName,
              });

              // 2. Log global en message_logs
              await logMessage({
                channel: "whatsapp",
                direction: "inbound",
                from,
                to: "",
                content: text || `[${msgType}]`,
                status: "received",
                metadata: {
                  providerMessageId: msg.id,
                  messageType: msgType,
                  contactName,
                  contactId: contactId || "",
                  isNewContact: isNew,
                  timestamp,
                },
              });

              // 3. Guardar en crm_contacts/{id}/messages/
              if (contactId) {
                await saveCrmMessage(contactId, {
                  channel: "whatsapp",
                  direction: "inbound",
                  from,
                  content: text || `[${msgType}]`,
                  messageType: msgType,
                  providerMessageId: msg.id,
                  status: "received",
                  contactName,
                });

                await updateCrmOnMessage(contactId, "inbound", "whatsapp");
              }

              // 4. Orquestador IA con Gemini: decidir acción
              const contactData = contactId ? (await db.collection("crm_contacts").doc(contactId).get()).data() : null;
              const decision = await processInboundMessage(text || `[${msgType}]`, contactData, { phone: from, contactId });

              // 5. Si auto_reply: enviar respuesta por WhatsApp
              if (decision.type === "auto_reply" && decision.reply) {
                const waToken = whatsappToken.value().trim();
                const waPhoneId = whatsappPhoneId.value().trim();

                console.log(`[WA Reply] Token present: ${!!waToken}, PhoneId: ${waPhoneId}, To: ${from}`);

                if (waToken && waPhoneId) {
                  try {
                    const replyResponse = await fetch(`https://graph.facebook.com/v21.0/${waPhoneId}/messages`, {
                      method: "POST",
                      headers: {
                        "Authorization": `Bearer ${waToken}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        messaging_product: "whatsapp",
                        to: from,
                        type: "text",
                        text: { body: decision.reply },
                      }),
                    });

                    const replyData = await replyResponse.json();
                    console.log(`[WA Reply] Status: ${replyResponse.status}, Response: ${JSON.stringify(replyData)}`);

                    if (!replyResponse.ok) {
                      console.error(`[WA Reply] ERROR: ${JSON.stringify(replyData)}`);
                    }

                    // Log respuesta automática
                    if (contactId) {
                      await saveCrmMessage(contactId, {
                        channel: "whatsapp",
                        direction: "outbound",
                        to: from,
                        content: decision.reply,
                        status: replyResponse.ok ? "sent" : "failed",
                        autoReply: true,
                        intent: decision.intent,
                      });
                      await updateCrmOnMessage(contactId, "outbound", "whatsapp");
                    }
                  } catch (replyErr) {
                    console.error("[WA Reply] Exception:", replyErr.message, replyErr.stack);
                  }
                } else {
                  console.error("[WA Reply] Missing token or phoneId!");
                }
              }

              // 6. Si escalate: notificar admins por Telegram
              if (decision.type === "escalate" || decision.needsHumanReview) {
                const escalationMsg =
                  `📩 *Mensaje WhatsApp entrante*\n\n` +
                  `👤 De: ${contactName || from}\n` +
                  `📱 Tel: ${from}\n` +
                  (contactId ? `🔗 CRM: ${contactId}${isNew ? " (NUEVO)" : ""}\n` : "") +
                  `🧠 Intención: ${decision.intent} (${Math.round(decision.confidence * 100)}%)\n` +
                  `💬 Mensaje: ${text || `[${msgType}]`}\n\n` +
                  `_${"Requiere atención humana"}_`;

                await notifyAdminsTelegram(escalationMsg, {
                  telegramBotToken,
                  telegramChatId,
                });
              }
            }
          }
        }

        return res.status(200).send("OK");
      } catch (err) {
        console.error("Error processing WhatsApp webhook:", err);
        return res.status(200).send("OK"); // Siempre 200 para Meta
      }
    }

    return res.status(405).send("Method not allowed");
  }
);

// ==============================================
// TELEGRAM: Notificación a admins (multi-admin)
// ==============================================
exports.sendTelegramNotification = onCall(
  { secrets: [telegramBotToken, telegramChatId], invoker: "public", cors: true },
  async (request) => {
    const { message } = request.data;

    if (!message) {
      throw new HttpsError("invalid-argument", "message requerido.");
    }

    const results = await notifyAdminsTelegram(message, {
      telegramBotToken,
      telegramChatId,
    });

    if (!results || results.length === 0) {
      return { status: "stub", message: "Telegram no configurado." };
    }

    return { status: "sent", results };
  }
);

// ==============================================
// TELEGRAM: Webhook para chatbot de clientes
// Mismo motor Gemini que WhatsApp
// ==============================================
exports.telegramWebhook = onRequest(
  { secrets: [telegramBotToken, telegramChatId, geminiApiKey] },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    try {
      const update = req.body;
      const msg = update?.message;

      if (!msg || !msg.text) {
        return res.status(200).send("OK");
      }

      const chatId = String(msg.chat.id);
      const text = msg.text;
      const firstName = msg.from?.first_name || "";
      const lastName = msg.from?.last_name || "";
      const username = msg.from?.username || "";
      const displayName = `${firstName} ${lastName}`.trim() || username || `tg_${chatId}`;

      // Ignorar comandos /start
      if (text === "/start") {
        const botToken = telegramBotToken.value();
        if (botToken) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: "¡Hola! 👋 Soy el asistente virtual de *Aquí Pauli* 🛍️\n\nPodés preguntarme sobre:\n• 👗 Productos y precios\n• 📦 Estado de pedidos\n• 💳 Métodos de pago\n• 🚚 Envíos\n\n¡Escribime lo que necesitás!",
              parse_mode: "Markdown",
            }),
          });
        }
        return res.status(200).send("OK");
      }

      // Solo ignorar mensajes de GRUPOS admin (chat IDs negativos)
      // Los chats privados siempre se procesan, incluso si es el admin
      const chatType = msg.chat?.type || "private";
      if (chatType === "group" || chatType === "supergroup") {
        let adminChatIds = [];
        try {
          const configSnap = await db.collection("config").doc("telegram").get();
          if (configSnap.exists) {
            adminChatIds = configSnap.data().chatIds || [];
          }
        } catch (_) { /* ignore */ }

        const fallbackChatId = telegramChatId.value();
        if (fallbackChatId) adminChatIds.push(fallbackChatId);

        if (adminChatIds.includes(chatId)) {
          return res.status(200).send("OK");
        }
      }

      // 1. Buscar o crear contacto CRM por Telegram
      const { findOrCreateContactByTelegram } = require("./crm");
      const { contactId, isNew } = await findOrCreateContactByTelegram(chatId, {
        displayName,
        username,
      });

      // 2. Log global
      await logMessage({
        channel: "telegram",
        direction: "inbound",
        from: chatId,
        to: "",
        content: text,
        status: "received",
        metadata: {
          telegramUsername: username,
          contactName: displayName,
          contactId: contactId || "",
          isNewContact: isNew,
        },
      });

      // 3. Guardar en CRM messages
      if (contactId) {
        await saveCrmMessage(contactId, {
          channel: "telegram",
          direction: "inbound",
          from: chatId,
          content: text,
          status: "received",
          contactName: displayName,
        });
        await updateCrmOnMessage(contactId, "inbound", "telegram");
      }

      // 4. Procesar con Gemini
      const contactData = contactId
        ? (await db.collection("crm_contacts").doc(contactId).get()).data()
        : null;
      const decision = await processInboundMessage(text, contactData, { contactId });

      // 5. Responder por Telegram
      const botToken = telegramBotToken.value();
      if (botToken && decision.reply) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: decision.reply,
            }),
          });

          // Log respuesta
          if (contactId) {
            await saveCrmMessage(contactId, {
              channel: "telegram",
              direction: "outbound",
              to: chatId,
              content: decision.reply,
              status: "sent",
              autoReply: true,
              intent: decision.intent,
            });
            await updateCrmOnMessage(contactId, "outbound", "telegram");
          }
        } catch (replyErr) {
          console.error("Error sending Telegram reply:", replyErr.message);
        }
      }

      // 6. Si necesita humano → notificar admins
      if (decision.type === "escalate" || decision.needsHumanReview) {
        const escalationMsg =
          `📩 *Mensaje Telegram entrante*\n\n` +
          `👤 De: ${displayName}\n` +
          `🆔 Chat: ${chatId}\n` +
          (username ? `📎 @${username}\n` : "") +
          (contactId ? `🔗 CRM: ${contactId}${isNew ? " (NUEVO)" : ""}\n` : "") +
          `🧠 Intención: ${decision.intent} (${Math.round(decision.confidence * 100)}%)\n` +
          `💬 Mensaje: ${text}\n\n` +
          `_Requiere atención humana_`;

        await notifyAdminsTelegram(escalationMsg, {
          telegramBotToken,
          telegramChatId,
        });
      }

      return res.status(200).send("OK");
    } catch (err) {
      console.error("Error processing Telegram webhook:", err);
      return res.status(200).send("OK");
    }
  }
);
