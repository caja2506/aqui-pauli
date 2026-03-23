const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { db, FieldValue } = require("./utils");

// ==============================================
// CAMPOS BASE DEL CONTACTO CRM CONVERSACIONAL
// ==============================================
const CRM_DEFAULT_FIELDS = {
  uid: "",
  email: "",
  displayName: "",
  phone: "",
  photoURL: "",
  // Embudo
  funnelStage: "visitante", // visitante | interesado | carrito | comprador_potencial | comprador | recurrente
  // Métricas
  totalOrders: 0,
  totalSpent: 0,
  lastOrderDate: "",
  // Timestamps conversacionales
  lastInteractionAt: "",
  lastInboundAt: "",
  lastOutboundAt: "",
  // Preferencias comerciales (memoria)
  preferredCategories: [],
  preferredBrands: [],
  preferredColors: [],
  preferredSizes: [],
  // IA / Conversación
  lastIntent: "",
  unresolvedAttentionRequired: false,
  unresolvedReason: "",
  conversationSummary: "",
  // Canales
  sourceChannels: [], // ["web", "whatsapp", "telegram"]
  // Admin
  notes: "",
  tags: [],
  source: "registro",
  createdAt: "",
  updatedAt: "",
};

// ==============================================
// TRIGGER: Al crear usuario en users_roles
// ==============================================
exports.onUserRoleCreated = onDocumentCreated(
  { document: "users_roles/{userId}" },
  async (event) => {
    const userId = event.params.userId;
    const userData = event.data.data();

    try {
      const crmRef = db.collection("crm_contacts").doc(userId);
      const existing = await crmRef.get();
      if (existing.exists) return;

      const now = new Date().toISOString();

      await crmRef.set({
        ...CRM_DEFAULT_FIELDS,
        uid: userId,
        email: userData.email || "",
        displayName: userData.displayName || "",
        phone: userData.phone || "",
        photoURL: userData.photoURL || "",
        sourceChannels: ["web"],
        lastInteractionAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // Interacción inicial
      await crmRef.collection("interactions").add({
        type: "registro",
        description: "Cliente se registró en la plataforma",
        channel: "web",
        createdAt: now,
        metadata: { method: userData.email ? "email" : "google" },
      });

      console.log(`CRM contact created for user ${userId}`);
    } catch (err) {
      console.error(`Error creating CRM contact for ${userId}:`, err);
    }
  }
);

// ==============================================
// HELPER: Buscar o crear contacto CRM por teléfono
// Para mensajes entrantes de WhatsApp de números desconocidos
// ==============================================
async function findOrCreateContactByPhone(phone, extraData = {}) {
  try {
    // 1. Buscar por phone
    const byPhone = await db.collection("crm_contacts")
      .where("phone", "==", phone)
      .limit(1)
      .get();

    if (!byPhone.empty) {
      return { contactId: byPhone.docs[0].id, isNew: false, data: byPhone.docs[0].data() };
    }

    // 2. No existe — crear contacto nuevo con ID autogenerado
    const now = new Date().toISOString();
    const newRef = db.collection("crm_contacts").doc();
    const newContact = {
      ...CRM_DEFAULT_FIELDS,
      phone,
      displayName: extraData.displayName || "",
      source: "whatsapp",
      funnelStage: "interesado",
      sourceChannels: ["whatsapp"],
      lastInteractionAt: now,
      lastInboundAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await newRef.set(newContact);

    // Interacción
    await newRef.collection("interactions").add({
      type: "primer_contacto",
      description: `Primer mensaje por WhatsApp desde ${phone}`,
      channel: "whatsapp",
      createdAt: now,
      metadata: { phone },
    });

    console.log(`CRM contact auto-created for phone ${phone}: ${newRef.id}`);
    return { contactId: newRef.id, isNew: true, data: newContact };
  } catch (err) {
    console.error(`Error findOrCreateContactByPhone ${phone}:`, err);
    return { contactId: null, isNew: false, data: null };
  }
}

// ==============================================
// HELPER: Guardar mensaje en crm_contacts/{id}/messages/
// ==============================================
async function saveCrmMessage(contactId, messageData) {
  if (!contactId) return null;
  try {
    const ref = await db.collection("crm_contacts").doc(contactId)
      .collection("messages").add({
        ...messageData,
        createdAt: messageData.createdAt || new Date().toISOString(),
      });
    return ref.id;
  } catch (err) {
    console.error(`Error saving CRM message for ${contactId}:`, err);
    return null;
  }
}

// ==============================================
// HELPER: Actualizar timestamps y canal en CRM
// ==============================================
async function updateCrmOnMessage(contactId, direction, channel, messageContent) {
  if (!contactId) return;
  try {
    const now = new Date().toISOString();
    const update = {
      lastInteractionAt: now,
      lastMessageAt: now,
      updatedAt: now,
      totalMessages: FieldValue.increment(1),
    };

    if (direction === "inbound") {
      update.lastInboundAt = now;
      if (messageContent) {
        update.lastMessageContent = messageContent.substring(0, 100);
      }
    } else if (direction === "outbound") {
      update.lastOutboundAt = now;
    }

    // Agregar canal si no existe
    if (channel) {
      update.sourceChannels = FieldValue.arrayUnion(channel);
      update.lastChannel = channel;
    }

    await db.collection("crm_contacts").doc(contactId).update(update);
  } catch (err) {
    console.error(`Error updateCrmOnMessage ${contactId}:`, err);
  }
}

// ==============================================
// HELPER: Actualizar CRM cuando se paga un pedido
// ==============================================
async function updateCrmOnOrderPaid(order, orderId) {
  const customerUid = order.customerUid;
  if (!customerUid) return;

  try {
    const crmRef = db.collection("crm_contacts").doc(customerUid);
    const crmSnap = await crmRef.get();
    const now = new Date().toISOString();

    if (!crmSnap.exists) {
      await crmRef.set({
        ...CRM_DEFAULT_FIELDS,
        uid: customerUid,
        email: order.customerEmail || "",
        displayName: order.customerName || "",
        phone: order.customerPhone || "",
        funnelStage: "comprador",
        totalOrders: 1,
        totalSpent: order.total || 0,
        lastOrderDate: now,
        lastInteractionAt: now,
        sourceChannels: ["web"],
        source: "compra",
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const crmData = crmSnap.data();
      const newTotalOrders = (crmData.totalOrders || 0) + 1;

      let newStage = crmData.funnelStage;
      if (newTotalOrders === 1) newStage = "comprador";
      else if (newTotalOrders >= 2) newStage = "recurrente";

      await crmRef.update({
        totalOrders: FieldValue.increment(1),
        totalSpent: FieldValue.increment(order.total || 0),
        lastOrderDate: now,
        lastInteractionAt: now,
        funnelStage: newStage,
        sourceChannels: FieldValue.arrayUnion("web"),
        ...((!crmData.phone && order.customerPhone) ? { phone: order.customerPhone } : {}),
        updatedAt: now,
      });
    }

    // Interacción
    await crmRef.collection("interactions").add({
      type: "compra",
      description: `Pedido ${order.orderNumber} pagado — ₡${(order.total || 0).toLocaleString()}`,
      channel: "web",
      orderId,
      amount: order.total || 0,
      createdAt: now,
      metadata: {
        orderNumber: order.orderNumber,
        paymentMethod: order.paymentMethod,
        hasBackorderItems: order.hasBackorderItems || false,
      },
    });

    console.log(`CRM updated for customer ${customerUid} (order ${orderId})`);
  } catch (err) {
    console.error(`Error updating CRM for ${customerUid}:`, err);
  }
}

// ==============================================
// HELPER: Actualizar CRM al crear orden (comprador_potencial)
// ==============================================
async function updateCrmOnOrderCreated(customerUid) {
  if (!customerUid) return;
  try {
    const crmRef = db.collection("crm_contacts").doc(customerUid);
    const crmSnap = await crmRef.get();
    const now = new Date().toISOString();

    if (!crmSnap.exists) {
      // Contacto CRM no existe → crearlo con datos de Auth
      const admin = require("firebase-admin");
      let userData = {};
      try {
        const authUser = await admin.auth().getUser(customerUid);
        userData = {
          email: authUser.email || "",
          displayName: authUser.displayName || "",
          photoURL: authUser.photoURL || "",
          phone: authUser.phoneNumber || "",
        };
      } catch (_) { /* user might not exist in Auth */ }

      await crmRef.set({
        ...CRM_DEFAULT_FIELDS,
        uid: customerUid,
        ...userData,
        funnelStage: "comprador_potencial",
        sourceChannels: ["web"],
        source: "orden",
        lastInteractionAt: now,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`CRM contact created for new buyer: ${customerUid}`);
      return;
    }

    const crmData = crmSnap.data();

    // Solo avanzar si está antes de comprador
    if (["visitante", "interesado", "carrito"].includes(crmData.funnelStage)) {
      await crmRef.update({
        funnelStage: "comprador_potencial",
        lastInteractionAt: now,
        updatedAt: now,
      });
    }
  } catch (err) {
    console.error(`Error updateCrmOnOrderCreated ${customerUid}:`, err);
  }
}

// ==============================================
// HELPER: Carrito abandonado
// ==============================================
async function updateCrmOnCartAbandoned(uid, cartItemCount) {
  try {
    const crmRef = db.collection("crm_contacts").doc(uid);
    const crmSnap = await crmRef.get();
    if (!crmSnap.exists) return;

    const crmData = crmSnap.data();
    const now = new Date().toISOString();

    if (["visitante", "interesado"].includes(crmData.funnelStage)) {
      await crmRef.update({
        funnelStage: "carrito",
        lastInteractionAt: now,
        updatedAt: now,
      });
    }

    await crmRef.collection("interactions").add({
      type: "carrito_abandonado",
      description: `Carrito abandonado con ${cartItemCount} producto(s)`,
      channel: "web",
      createdAt: now,
      metadata: { itemCount: cartItemCount },
    });
  } catch (err) {
    console.error(`Error updating CRM for cart abandoned ${uid}:`, err);
  }
}

// ==============================================
// HELPER: Marcar atención no resuelta
// ==============================================
async function markUnresolved(contactId, reason) {
  if (!contactId) return;
  try {
    await db.collection("crm_contacts").doc(contactId).update({
      unresolvedAttentionRequired: true,
      unresolvedReason: reason || "Mensaje no resuelto automáticamente",
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`Error markUnresolved ${contactId}:`, err);
  }
}

// ==============================================
// HELPER: Buscar o crear contacto CRM por Telegram chatId
// ==============================================
async function findOrCreateContactByTelegram(chatId, extraData = {}) {
  try {
    // 1. Buscar por telegramChatId
    const byChatId = await db.collection("crm_contacts")
      .where("telegramChatId", "==", chatId)
      .limit(1)
      .get();

    if (!byChatId.empty) {
      return { contactId: byChatId.docs[0].id, isNew: false, data: byChatId.docs[0].data() };
    }

    // 2. No existe — crear contacto nuevo
    const now = new Date().toISOString();
    const newRef = db.collection("crm_contacts").doc();
    const newContact = {
      ...CRM_DEFAULT_FIELDS,
      telegramChatId: chatId,
      telegramUsername: extraData.username || "",
      displayName: extraData.displayName || "",
      source: "telegram",
      funnelStage: "interesado",
      sourceChannels: ["telegram"],
      lastInteractionAt: now,
      lastInboundAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await newRef.set(newContact);
    console.log(`CRM contact created from Telegram: ${chatId} -> ${newRef.id}`);
    return { contactId: newRef.id, isNew: true, data: newContact };
  } catch (err) {
    console.error("Error findOrCreateContactByTelegram:", err);
    return { contactId: null, isNew: false, data: null };
  }
}

// ==============================================
// CALLABLE: Limpiar historial de mensajes de un contacto
// Usa Admin SDK — bypasea reglas de seguridad
// ==============================================
const { onCall, HttpsError } = require("firebase-functions/v2/https");

exports.clearChatHistory = onCall(async (request) => {
  // Verificar autenticación
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debés estar logueado");
  }

  // Verificar que es admin
  const roleSnap = await db.collection("users_roles").doc(request.auth.uid).get();
  if (!roleSnap.exists || roleSnap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Solo admin puede limpiar historial");
  }

  const contactId = request.data.contactId;
  if (!contactId) {
    throw new HttpsError("invalid-argument", "contactId requerido");
  }

  try {
    const msgsSnap = await db.collection("crm_contacts").doc(contactId)
      .collection("messages").get();

    if (msgsSnap.empty) {
      return { success: true, deleted: 0 };
    }

    // Firestore batch max 500, usar chunks
    const chunks = [];
    for (let i = 0; i < msgsSnap.docs.length; i += 450) {
      chunks.push(msgsSnap.docs.slice(i, i + 450));
    }

    let totalDeleted = 0;
    for (const chunk of chunks) {
      const batch = db.batch();
      chunk.forEach(d => batch.delete(d.ref));
      await batch.commit();
      totalDeleted += chunk.length;
    }

    // También borrar la sesión del bot para que no tenga contexto anterior
    const contactSnap = await db.collection("crm_contacts").doc(contactId).get();
    if (contactSnap.exists) {
      const phone = contactSnap.data().phone;
      if (phone) {
        const sessionBatch = db.batch();
        sessionBatch.delete(db.collection("bot_sessions").doc(`${phone}_whatsapp`));
        sessionBatch.delete(db.collection("bot_sessions").doc(`${phone}_telegram`));
        await sessionBatch.commit();
        console.log(`[Admin] Sesiones del bot borradas para ${phone}`);
      }
    }

    console.log(`[Admin] ${request.auth.uid} limpió historial de ${contactId}: ${totalDeleted} mensajes`);
    return { success: true, deleted: totalDeleted };
  } catch (err) {
    console.error("Error clearing chat history:", err);
    throw new HttpsError("internal", "Error al limpiar: " + err.message);
  }
});

module.exports = {
  onUserRoleCreated: exports.onUserRoleCreated,
  clearChatHistory: exports.clearChatHistory,
  CRM_DEFAULT_FIELDS,
  findOrCreateContactByPhone,
  findOrCreateContactByTelegram,
  saveCrmMessage,
  updateCrmOnMessage,
  updateCrmOnOrderPaid,
  updateCrmOnOrderCreated,
  updateCrmOnCartAbandoned,
  markUnresolved,
};
