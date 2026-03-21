const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// ==============================================
// SECRETS (configurar con: firebase functions:secrets:set <SECRET_NAME>)
// ==============================================
const whatsappToken = defineSecret("WHATSAPP_TOKEN");
const whatsappPhoneId = defineSecret("WHATSAPP_PHONE_ID");
const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");
const telegramChatId = defineSecret("TELEGRAM_CHAT_ID");
const paypalClientId = defineSecret("PAYPAL_CLIENT_ID");
const paypalSecret = defineSecret("PAYPAL_SECRET");

// ==============================================
// PEDIDOS: Al cambiar a "pagado"
// Descuenta inventario, pasa a "por_preparar",
// notifica por Telegram
// ==============================================
exports.onOrderStatusChange = onDocumentUpdated(
  { document: "orders/{orderId}", secrets: [telegramBotToken, telegramChatId] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const orderId = event.params.orderId;

    // Solo actuar cuando el estado cambia a "pagado"
    if (before.status === after.status || after.status !== "pagado") return;

    try {
      // 1. Descontar inventario
      const itemsSnap = await db.collection("orders").doc(orderId).collection("items").get();
      const batch = db.batch();

      for (const itemDoc of itemsSnap.docs) {
        const item = itemDoc.data();
        if (item.supplyType === "stock_propio") {
          const variantRef = db
            .collection("products")
            .doc(item.productId)
            .collection("variants")
            .doc(item.variantId);

          batch.update(variantRef, {
            stock: FieldValue.increment(-item.quantity),
            reservedStock: FieldValue.increment(-item.quantity),
          });
        }
      }

      // 2. Pasar a "por_preparar"
      batch.update(db.collection("orders").doc(orderId), {
        status: "por_preparar",
        updatedAt: new Date().toISOString(),
      });

      await batch.commit();

      // 3. Notificar por Telegram
      const token = telegramBotToken.value();
      const chatId = telegramChatId.value();
      if (token && chatId) {
        const message = `🛒 *Nuevo pedido pagado*\n\n` +
          `📦 Orden: ${after.orderNumber}\n` +
          `👤 Cliente: ${after.customerName}\n` +
          `💰 Total: ₡${after.total?.toLocaleString()}\n` +
          `💳 Método: ${after.paymentMethod}`;

        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown",
          }),
        });
      }
    } catch (err) {
      console.error("Error processing paid order:", err);
    }
  }
);

// ==============================================
// CONCILIACIÓN DE PAGOS
// Callable: verifica si un pago coincide al 100%
// ==============================================
exports.reconcilePayment = onCall(
  { secrets: [] },
  async (request) => {
    const { orderId, paymentData } = request.data;

    if (!orderId || !paymentData) {
      throw new HttpsError("invalid-argument", "orderId y paymentData requeridos.");
    }

    const orderSnap = await db.collection("orders").doc(orderId).get();
    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Pedido no encontrado.");
    }

    const order = orderSnap.data();
    const { amount, phone, date } = paymentData;

    // Conciliación automática: verificar coincidencia
    const amountMatch = Math.abs(amount - order.total) <= 1; // tolerancia ₡1
    const phoneMatch = !order.paymentPhone || phone === order.paymentPhone;

    if (amountMatch && phoneMatch) {
      // 100% match — marcar como pagado
      await db.collection("orders").doc(orderId).update({
        paymentStatus: "pagado",
        status: "pagado",
        paymentAmount: amount,
        paymentDate: date || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return { result: "auto_approved", message: "Pago verificado automáticamente." };
    } else {
      // No match — enviar a revisión manual
      await db.collection("orders").doc(orderId).update({
        paymentStatus: "verificando",
        status: "revision_manual",
        paymentAmount: amount,
        paymentDate: date || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return { result: "manual_review", message: "Enviado a revisión manual." };
    }
  }
);

// ==============================================
// WHATSAPP: Envío de mensaje (stub)
// ==============================================
exports.sendWhatsAppMessage = onCall(
  { secrets: [whatsappToken, whatsappPhoneId] },
  async (request) => {
    const { to, message } = request.data;

    if (!to || !message) {
      throw new HttpsError("invalid-argument", "to y message requeridos.");
    }

    const token = whatsappToken.value();
    const phoneId = whatsappPhoneId.value();

    if (!token || !phoneId) {
      // Stub: log en lugar de enviar
      console.log(`[WhatsApp STUB] To: ${to}, Message: ${message}`);
      return { status: "stub", message: "WhatsApp no configurado. Mensaje logueado." };
    }

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
            to: to,
            type: "text",
            text: { body: message },
          }),
        }
      );

      const data = await response.json();
      if (!response.ok) {
        throw new HttpsError("internal", data.error?.message || "Error enviando WhatsApp");
      }

      return { status: "sent", messageId: data.messages?.[0]?.id };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", err.message);
    }
  }
);

// ==============================================
// TELEGRAM: Notificación a admins
// ==============================================
exports.sendTelegramNotification = onCall(
  { secrets: [telegramBotToken, telegramChatId] },
  async (request) => {
    const { message } = request.data;

    if (!message) {
      throw new HttpsError("invalid-argument", "message requerido.");
    }

    const token = telegramBotToken.value();
    const chatId = telegramChatId.value();

    if (!token || !chatId) {
      console.log(`[Telegram STUB] Message: ${message}`);
      return { status: "stub", message: "Telegram no configurado. Mensaje logueado." };
    }

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown",
          }),
        }
      );

      const data = await response.json();
      if (!data.ok) {
        throw new HttpsError("internal", data.description || "Error enviando Telegram");
      }

      return { status: "sent" };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", err.message);
    }
  }
);

// ==============================================
// AUTOMATIZACIÓN: Limpiar reservas expiradas
// Se ejecuta diariamente a medianoche (Costa Rica UTC-6)
// ==============================================
exports.cleanExpiredReservations = onSchedule(
  { schedule: "0 0 * * *", timeZone: "America/Costa_Rica" },
  async () => {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

      // Buscar pedidos pendientes de pago creados antes de hoy
      const pendingOrders = await db.collection("orders")
        .where("status", "==", "pendiente_pago")
        .where("createdAt", "<", todayStart)
        .get();

      const batch = db.batch();
      let cleaned = 0;

      for (const orderDoc of pendingOrders.docs) {
        const order = orderDoc.data();

        // Liberar stock reservado
        const itemsSnap = await db.collection("orders").doc(orderDoc.id).collection("items").get();
        for (const itemDoc of itemsSnap.docs) {
          const item = itemDoc.data();
          if (item.supplyType === "stock_propio") {
            const variantRef = db
              .collection("products")
              .doc(item.productId)
              .collection("variants")
              .doc(item.variantId);

            batch.update(variantRef, {
              reservedStock: FieldValue.increment(-item.quantity),
            });
          }
        }

        // Cancelar el pedido
        batch.update(orderDoc.ref, {
          status: "cancelado",
          notes: "Cancelado automáticamente por falta de pago",
          updatedAt: new Date().toISOString(),
        });

        cleaned++;
      }

      if (cleaned > 0) {
        await batch.commit();
        console.log(`Cleaned ${cleaned} expired reservations.`);
      }

      return null;
    } catch (err) {
      console.error("Error cleaning expired reservations:", err);
      return null;
    }
  }
);

// ==============================================
// AUTOMATIZACIÓN: Carrito abandonado (stub)
// Se ejecuta diariamente a las 10am
// ==============================================
exports.processAbandonedCarts = onSchedule(
  { schedule: "0 10 * * *", timeZone: "America/Costa_Rica", secrets: [whatsappToken, whatsappPhoneId] },
  async () => {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const cartsSnap = await db.collection("carts")
        .where("abandonedNotificationSent", "==", false)
        .get();

      let processed = 0;

      for (const cartDoc of cartsSnap.docs) {
        const cart = cartDoc.data();
        const updatedAt = new Date(cart.updatedAt || 0);

        // Solo procesar carritos actualizados hace más de 24h
        if (updatedAt > yesterday) continue;
        if (!cart.items || cart.items.length === 0) continue;

        // Obtener datos del usuario
        const userRoleSnap = await db.collection("users_roles").doc(cartDoc.id).get();
        if (!userRoleSnap.exists) continue;

        const userData = userRoleSnap.data();

        // Registrar automatización
        await db.collection("automations").add({
          type: "abandoned_cart",
          status: "pending",
          targetUid: cartDoc.id,
          orderId: "",
          scheduledAt: new Date().toISOString(),
          executedAt: "",
          channel: "whatsapp",
          metadata: {
            itemCount: cart.items.length,
            customerName: userData.displayName || "",
            customerPhone: userData.phone || "",
          },
        });

        // Marcar como notificado
        await db.collection("carts").doc(cartDoc.id).update({
          abandonedNotificationSent: true,
        });

        processed++;
      }

      console.log(`Processed ${processed} abandoned carts.`);
      return null;
    } catch (err) {
      console.error("Error processing abandoned carts:", err);
      return null;
    }
  }
);
