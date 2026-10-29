const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { db, notifyAdminsTelegram, logAutomation, generateOrderNumber } = require("./utils");
const { CRM_DEFAULT_FIELDS, updateCrmOnOrderCreated } = require("./crm");
const { sendPaidOrderEmail } = require("./lib/orderEmail");
const { computeTotalsCRC } = require("./lib/pricing");
const fulfillment = require("./lib/orderFulfillment");

const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");
const telegramChatId = defineSecret("TELEGRAM_CHAT_ID");
// Vincular Gmail por nombre evita resolver secretos aún ausentes al descubrir
// otros endpoints. Solo este trigger los necesita cuando se despliega/ejecuta.
const gmailSmtpUser = "GMAIL_SMTP_USER";
const gmailSmtpAppPassword = "GMAIL_SMTP_APP_PASSWORD";
const { computeBackorderDeposit } = require("./lib/backorderDeposit");
const MAX_ORDER_EVENT_AGE_MS = 60 * 60 * 1000;
const PAYMENT_METHODS = new Set(["sinpe", "sinpe_movil", "transferencia", "efectivo", "paypal", "tilopay"]);
const clean = (value, max = 250) => typeof value === "string" ? value.trim().slice(0, max) : "";

// El servidor no recibe precios, stock, supplyType ni estados financieros como autoridad.
exports.createOrderWithReservation = onCall(
  { secrets: [], invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión para crear un pedido.");
    const data = request.data || {};
    const customerName = clean(data.customerName, 150);
    const paymentMethod = data.paymentMethod;
    if (!customerName || !PAYMENT_METHODS.has(paymentMethod)) throw new HttpsError("invalid-argument", "Datos de pedido incompletos.");
    if (!Array.isArray(data.items) || !data.items.length || data.items.length > 50) throw new HttpsError("invalid-argument", "Items inválidos.");
    // Rechazar duplicados evita reservar una variante dos veces contra la misma disponibilidad.
    const seen = new Set();
    const items = data.items.map((item) => {
      if (!fulfillment.validDocumentId(item?.productId) || !fulfillment.validDocumentId(item?.variantId)
          || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
        throw new HttpsError("invalid-argument", "Producto o cantidad inválidos.");
      }
      const key = JSON.stringify([item.productId, item.variantId]);
      if (seen.has(key)) throw new HttpsError("invalid-argument", "Una variante no puede repetirse en el pedido.");
      seen.add(key);
      return { productId: item.productId, variantId: item.variantId, quantity: item.quantity };
    });
    const shippingType = data.shippingType || "normal";
    if (!["normal", "express"].includes(shippingType)) throw new HttpsError("invalid-argument", "Tipo de envío inválido.");
    const shippingAddress = Object.fromEntries(["provincia", "canton", "distrito", "codigoPostal", "señas"]
      .map((key) => [key, clean(data.shippingAddress?.[key], key === "señas" ? 1000 : 150)]));
    const customerUid = request.auth.uid;
    const orderRef = db.collection("orders").doc();
    const orderId = orderRef.id;
    const orderNumber = generateOrderNumber();
    const now = new Date().toISOString();

    try {
      await db.runTransaction(async (transaction) => {
        let totals;
        try {
          totals = await computeTotalsCRC(db, items, { canton: shippingAddress.canton, shippingType }, { transaction });
        } catch (error) {
          throw new HttpsError("failed-precondition", error.message);
        }
        const canonical = fulfillment.normalizeLines(totals.lines, { priced: true });
        // Tilopay reserva cuando crea el intento LIVE, en su propia transacción. Un pedido TEST no reserva nada.
        const reserveLines = paymentMethod === "tilopay" ? [] : canonical.filter((line) => line.supplyType === "stock_propio");
        const reserves = [];
        for (const line of reserveLines) {
          const ref = db.collection("products").doc(line.productId).collection("variants").doc(line.variantId);
          const snap = await transaction.get(ref);
          if (!snap.exists) throw new HttpsError("not-found", "Variante no encontrada.");
          const stock = fulfillment.checkedStock(snap.data());
          if (stock.stock - stock.reservedStock < line.quantity) {
            throw new HttpsError("failed-precondition", `Stock insuficiente para ${line.productName || line.name || line.productId}.`);
          }
          reserves.push({ ref, line, ...stock });
        }

        // Anticipo: 20% del total completo del pedido (regla de Carlos; igual que el checkout del navegador).
        const deposit = computeBackorderDeposit(canonical, totals.total);
        const orderItems = canonical.map((line, index) => {
          const depositAmount = deposit.depositByLine[index];
          return {
            itemId: `item_${index}`, productId: line.productId, variantId: line.variantId,
            productName: line.productName || line.name || "", variantName: line.variantName || "",
            imageUrl: line.imageUrl || "", price: line.unitPrice, quantity: line.quantity,
            subtotal: line.lineTotal, lineTotal: line.lineTotal, supplyType: line.supplyType,
            depositAmount, depositPaid: false, remainingPaid: false,
          };
        });
        const hasBackorderItems = deposit.hasBackorder;
        const depositTotal = deposit.depositTotal;
        // Todas las lecturas de productos, configuración y variantes terminaron antes de escribir.
        for (const reserve of reserves) transaction.update(reserve.ref, { reservedStock: reserve.reservedStock + reserve.line.quantity });
        transaction.set(orderRef, {
          orderNumber, uid: customerUid, customerUid,
          customerEmail: clean(data.customerEmail, 320), customerName, customerPhone: clean(data.customerPhone, 40),
          status: "pendiente_pago", paymentStatus: "pendiente", paymentMethod,
          paymentProofUrl: "", paymentPhone: clean(data.paymentPhone, 40),
          paymentTransactionId: "", paymentAmount: 0, paymentDate: "",
          subtotal: totals.subtotal, shippingCost: totals.shippingCost, total: totals.total,
          shippingType, shippingAddress, trackingNumber: "", trackingUrl: "",
          hasBackorderItems, hasBackorder: hasBackorderItems, backorderDeposit: depositTotal, depositTotal, remainingTotal: hasBackorderItems ? totals.total - depositTotal : 0,
          depositStatus: hasBackorderItems ? "pendiente" : "no_aplica",
          remainingStatus: hasBackorderItems ? "pendiente" : "no_aplica",
          backorderDepositPaid: false, backorderRemainingPaid: false,
          itemsSummary: orderItems, itemCount: orderItems.reduce((sum, line) => sum + line.quantity, 0),
          ...(reserveLines.length ? { inventoryReservation: {
            version: 1, state: "reserved", createdAt: now,
            lines: reserveLines.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
          } } : {}),
          notes: "", createdAt: now, updatedAt: now,
        });
        for (const item of orderItems) transaction.set(orderRef.collection("items").doc(item.itemId), item);
      });
      // Test y live Tilopay comparten este callable; sus efectos comerciales esperan a la captura live.
      if (paymentMethod !== "tilopay") await updateCrmOnOrderCreated(customerUid);
      return { orderId, orderNumber };
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      console.error("Error creating order with reservation:", error.message);
      throw new HttpsError("internal", "Error al crear el pedido. Intenta de nuevo.");
    }
  }
);

async function sendPaidEffects(orderId, kind = "paid") {
  for (const channel of ["telegram", "email"]) {
    const claimed = await fulfillment.claimPaidEffect({ db, orderId, channel, kind });
    if (!claimed) continue;
    try {
      if (channel === "telegram") {
        const order = claimed.order;
        const text = (value) => String(value ?? "—").replace(/([_*`\[\]\\])/g, "\\$1");
        const message = claimed.requiresReview
          ? `⚠️ *Pagado pero requiere revisión*\n\n📦 Orden: ${text(order.orderNumber || orderId)}\n` +
            `👤 Cliente: ${text(order.customerName)}\n💰 Pago acreditado: ₡${text(order.total?.toLocaleString("es-CR"))}\n` +
            `💳 Método: ${text(order.paymentMethod)}\nTransacción: ${text(order.paymentTransactionId)}\n` +
            `Motivo: ${text(claimed.reviewReason)}\n\nRevisá el pedido en el admin antes de prepararlo o enviarlo.`
          : `🛒 *Nuevo pedido pagado*\n\n📦 Orden: ${order.orderNumber}\n` +
            `👤 Cliente: ${order.customerName}\n💰 Total: ₡${order.total?.toLocaleString()}\n💳 Método: ${order.paymentMethod}`;
        const recipients = await notifyAdminsTelegram(message, { telegramBotToken, telegramChatId });
        const unconfigured = !Array.isArray(recipients) || recipients.length === 0;
        const incomplete = !unconfigured && recipients.some((recipient) => recipient.ok !== true);
        await fulfillment.finishPaidEffect({ db, orderId, channel, kind,
          state: unconfigured ? "disabled" : incomplete ? "needs_review" : "sent",
          reason: unconfigured ? "Telegram sin credenciales o destinatarios" : incomplete ? "Al menos un destinatario no confirmó el envío" : undefined });
      } else {
        const result = await sendPaidOrderEmail({ db, orderId, order: claimed.order, items: claimed.items,
          user: process.env.GMAIL_SMTP_USER, pass: process.env.GMAIL_SMTP_APP_PASSWORD,
          requiresReview: claimed.requiresReview === true, reviewReason: claimed.reviewReason });
        await fulfillment.finishPaidEffect({ db, orderId, channel, kind,
          state: result.result === "error" ? "needs_review" : result.result,
          reason: result.reason });
      }
    } catch (error) {
      console.error(`[paidEffect] ${orderId}/${channel}:`, error.message);
      await fulfillment.finishPaidEffect({ db, orderId, channel, kind, state: "needs_review", reason: error.message });
    }
  }
}

exports.onOrderStatusChange = onDocumentUpdated(
  { document: "orders/{orderId}", retry: true,
    secrets: [telegramBotToken, telegramChatId, gmailSmtpUser, gmailSmtpAppPassword] },
  async (event) => {
    // CloudEvent.time conserva la fecha original durante los reintentos. Nunca usar
    // updatedAt del pedido: una escritura nueva no rejuvenece un evento antiguo.
    const occurredAt = Date.parse(event.time);
    if (!Number.isFinite(occurredAt) || Date.now() - occurredAt > MAX_ORDER_EVENT_AGE_MS) {
      console.warn("[onOrderStatusChange] Evento descartado por antigüedad o fecha inválida", {
        eventId: event.id || "", orderId: event.params?.orderId || "", eventTime: event.time || "",
      });
      return;
    }
    const before = event.data.before.data();
    const after = event.data.after.data();
    const orderId = event.params.orderId;
    if (before.status === after.status) return;

    // El evento puede llegar duplicado o tarde: cada operación lee el pedido ACTUAL en una transacción.
    if (after.status === "pagado") {
      await fulfillment.applyPaidOrder({ db, orderId, crmDefaults: CRM_DEFAULT_FIELDS });
      await sendPaidEffects(orderId);
      await sendPaidEffects(orderId, "review");
    }
    // El cambio a revisión también puede llegar antes/después del evento de pago.
    if (after.status === "revision_manual") await sendPaidEffects(orderId, "review");
    // Permite reanudar un aviso aún no reclamado si el worker terminó tras aplicar inventario.
    if (before.status === "pagado" && after.status === "por_preparar") await sendPaidEffects(orderId);
    if (after.status === "cancelado") await fulfillment.releaseCancelledReservation({ db, orderId });

    // Las automatizaciones posteriores también verifican el estado actual. Un evento
    // antiguo o un pedido de prueba nunca dispara un seguimiento comercial.
    let current = null;
    if (["enviado", "entregado"].includes(after.status)) {
      const snap = await db.collection("orders").doc(orderId).get();
      current = snap.exists ? snap.data() : null;
      if (!current || current.status !== after.status || fulfillment.isTerminalOrder(current)) return;
      if (fulfillment.hasTilopay(current)) {
        try { fulfillment.paidTilopaySnapshot(current); } catch { return; }
      }
    }
    if (after.status === "enviado" && current.trackingNumber) {
      await logAutomation({
        type: "post_sale_tracking", targetUid: current.customerUid || current.uid, orderId, channel: "whatsapp",
        metadata: { customerName: current.customerName, customerPhone: current.customerPhone,
          orderNumber: current.orderNumber, trackingNumber: current.trackingNumber, trackingUrl: current.trackingUrl || "" },
      });
    }
    if (after.status === "entregado") {
      const reviewDate = new Date();
      reviewDate.setDate(reviewDate.getDate() + 2);
      await logAutomation({
        type: "post_sale_review", targetUid: current.customerUid || current.uid, orderId,
        scheduledAt: reviewDate.toISOString(), channel: "whatsapp",
        metadata: { customerName: current.customerName, customerPhone: current.customerPhone, orderNumber: current.orderNumber },
      });
    }
  }
);

exports.deleteOrder = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Debés estar logueado.");
  const orderId = request.data?.orderId;
  if (!fulfillment.validDocumentId(orderId)) throw new HttpsError("invalid-argument", "orderId requerido.");
  try {
    const orderNumber = await db.runTransaction(async (transaction) => {
      const role = await transaction.get(db.collection("users_roles").doc(request.auth.uid));
      if (!role.exists || role.data().role !== "admin") throw new HttpsError("permission-denied", "Solo admin puede eliminar pedidos.");
      const ref = db.collection("orders").doc(orderId);
      const snap = await transaction.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
      const order = snap.data();
      if (fulfillment.hasTilopay(order)) {
        throw new HttpsError("failed-precondition", "Los pedidos Tilopay conservan sus referencias de pago. Cancela el pedido y concilia sus intentos; no lo elimines.");
      }
      const items = await transaction.get(ref.collection("items"));
      const releases = order.inventoryReservation?.state === "reserved"
        ? await fulfillment.reservationReleasePlan({ db, transaction, order }) : [];
      for (const variant of releases) transaction.update(variant.ref, { reservedStock: variant.reservedStock - variant.line.quantity });
      for (const item of items.docs) transaction.delete(item.ref);
      transaction.delete(ref);
      return order.orderNumber || orderId;
    });
    console.log(`[Admin] ${request.auth.uid} eliminó pedido ${orderNumber}`);
    return { success: true, orderNumber };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("Error deleting order:", error.message);
    throw new HttpsError("internal", "Error al eliminar el pedido.");
  }
});
