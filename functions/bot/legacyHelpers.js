// ==============================================
// LEGACY HELPERS — Funciones reutilizables del conversation.js original
// Estas funciones se mantienen para compatibilidad con el flujo existente
// Se usan desde el nuevo orquestador para consultar órdenes
// ==============================================

const { db } = require("../utils");

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
  verificando: "Verificando pago",
  revision_manual: "En revisión",
  revision_humana: "En revisión",
};

function formatOrderLine(order) {
  const num = order.orderNumber || "?";
  const status = STATUS_LABELS[order.status] || order.status;
  const total = order.total || 0;
  const date = order.createdAt?.substring(0, 10) || "N/A";
  const items = order.items?.length || order.itemsSummary?.length || 0;
  return `- ${num}: ${status}, ₡${total.toLocaleString()}, ${items} producto(s), fecha: ${date}`;
}

// ==============================================
// BUSCAR ÓRDENES POR TELÉFONO DEL CLIENTE
// ==============================================
async function getOrdersByPhone(phone) {
  if (!phone) return "";

  try {
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

    if (contact.email) {
      const snap = await db.collection("orders")
        .where("customerEmail", "==", contact.email)
        .limit(5)
        .get();
      for (const doc of snap.docs) {
        allOrders.push({ id: doc.id, ...doc.data() });
      }
    }

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

module.exports = {
  getOrderContext,
  getOrdersByPhone,
  getOrdersByCustomerInfo,
  formatOrderLine,
  STATUS_LABELS,
};
