const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const db = getFirestore();

// ==============================================
// HELPER: Notificar admins por Telegram
// Lee chatIds de config/telegram. Fallback a secret.
// ==============================================
async function notifyAdminsTelegram(message, { telegramBotToken, telegramChatId } = {}) {
  const token = telegramBotToken?.value?.() || telegramBotToken;
  if (!token) {
    console.log("[Telegram STUB] No token configured. Message:", message);
    return;
  }

  // Intentar leer config multi-admin
  let chatIds = [];
  try {
    const configSnap = await db.collection("config").doc("telegram").get();
    if (configSnap.exists && configSnap.data().chatIds?.length > 0 && configSnap.data().enabled !== false) {
      chatIds = configSnap.data().chatIds;
    }
  } catch (err) {
    console.warn("Could not read config/telegram:", err.message);
  }

  // Fallback a secret individual
  if (chatIds.length === 0) {
    const fallbackId = telegramChatId?.value?.() || telegramChatId;
    if (fallbackId) chatIds = [fallbackId];
  }

  if (chatIds.length === 0) {
    console.log("[Telegram STUB] No chatIds configured. Message:", message);
    return;
  }

  // Enviar a todos los admins
  const results = [];
  for (const chatId of chatIds) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
        }),
      });
      const data = await response.json();
      results.push({ chatId, ok: data.ok });
    } catch (err) {
      console.error(`Error sending Telegram to ${chatId}:`, err.message);
      results.push({ chatId, ok: false, error: err.message });
    }
  }
  return results;
}

// ==============================================
// HELPER: Leer config/app centralizada (cache 5min)
// ==============================================
let _appConfigCache = null;
let _appConfigExpires = 0;
const APP_CONFIG_TTL_MS = 5 * 60 * 1000; // 5 minutos

const APP_CONFIG_DEFAULTS = {
  reviewLink: "",
  cartAbandonmentHours: 24,
  reviewRequestDays: 3,
  backorderReminderDays: 1,
  automationToggles: {
    cartAbandoned: true,
    reviewRequest: true,
    backorderPayment: true,
    trackingUpdate: true,
  },
  whatsappDefaults: {
    businessName: "Aquí Pauli",
    greeting: "¡Hola! Soy Aquí Pauli 🛍️",
  },
  messageTemplates: {
    cartAbandoned: "¡Hola {name}! 🛒 Notamos que dejaste productos en tu carrito. ¿Te ayudamos a completar tu compra?",
    reviewRequest: "¡Gracias por tu compra, {name}! 🌟 ¿Podrías dejarnos tu reseña? {reviewLink}",
    backorderPayment: "¡Hola {name}! Tu pedido #{orderNumber} está listo. El saldo pendiente es ₡{remaining}. ¿Procedemos con el cobro?",
    trackingUpdate: "¡{name}! Tu pedido #{orderNumber} ha sido actualizado a: {status}.",
  },
};

async function getAppConfig() {
  const now = Date.now();
  if (_appConfigCache && now < _appConfigExpires) {
    return _appConfigCache;
  }

  try {
    const snap = await db.collection("config").doc("app").get();
    if (snap.exists) {
      _appConfigCache = { ...APP_CONFIG_DEFAULTS, ...snap.data() };
    } else {
      _appConfigCache = { ...APP_CONFIG_DEFAULTS };
    }
  } catch (err) {
    console.warn("Could not read config/app:", err.message);
    _appConfigCache = { ...APP_CONFIG_DEFAULTS };
  }

  _appConfigExpires = now + APP_CONFIG_TTL_MS;
  return _appConfigCache;
}

// ==============================================
// HELPER: Registrar automatización (contrato mejorado)
// ==============================================
async function logAutomation({
  type,
  status = "pending",
  targetUid = "",
  targetContact = "",
  targetContactId = "",
  orderId = "",
  scheduledAt = null,
  channel = "whatsapp",
  metadata = {},
}) {
  const now = new Date().toISOString();
  const doc = await db.collection("automations").add({
    type,
    status,
    targetUid,
    targetContact,
    targetContactId,
    orderId,
    scheduledAt: scheduledAt || now,
    executedAt: "",
    channel,
    metadata,
    result: "",
    errorMessage: "",
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  return doc.id;
}

// ==============================================
// HELPER: Registrar mensaje enviado/recibido
// ==============================================
async function logMessage({
  channel,
  direction = "outbound",
  to = "",
  from = "",
  content = "",
  relatedOrderId = "",
  relatedContactUid = "",
  status = "sent",
  metadata = {},
}) {
  const doc = await db.collection("message_logs").add({
    channel,
    direction,
    to,
    from,
    content,
    relatedOrderId,
    relatedContactUid,
    status,
    sentAt: new Date().toISOString(),
    metadata,
  });
  return doc.id;
}

// ==============================================
// HELPER: Generar número de orden
// ==============================================
function generateOrderNumber() {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `AP-${y}${m}${d}-${rand}`;
}

module.exports = {
  db,
  FieldValue,
  notifyAdminsTelegram,
  logAutomation,
  logMessage,
  generateOrderNumber,
  getAppConfig,
  APP_CONFIG_DEFAULTS,
};
