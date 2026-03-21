const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { db, FieldValue, notifyAdminsTelegram, logAutomation, generateOrderNumber } = require("./utils");
const { updateCrmOnOrderPaid, updateCrmOnOrderCreated } = require("./crm");

const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");
const telegramChatId = defineSecret("TELEGRAM_CHAT_ID");

// Anticipo bajo pedido: 20%
const BACKORDER_DEPOSIT_PERCENT = 0.20;

// ==============================================
// CALLABLE: Crear pedido con reserva atómica
// ==============================================
exports.createOrderWithReservation = onCall(
  { secrets: [], invoker: "public", cors: true },
  async (request) => {
    // Validar autenticación
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para crear un pedido.");
    }

    const {
      customerEmail, customerName, customerPhone,
      paymentMethod, paymentPhone,
      subtotal, shippingCost, shippingType, shippingAddress,
      items,
    } = request.data;

    // Validaciones básicas
    if (!customerName || !paymentMethod || !items?.length) {
      throw new HttpsError("invalid-argument", "Datos de pedido incompletos.");
    }

    const customerUid = request.auth.uid;
    const orderId = db.collection("orders").doc().id;
    const orderNumber = generateOrderNumber();
    const now = new Date().toISOString();

    try {
      await db.runTransaction(async (transaction) => {
        // ── 1. Validar stock y preparar reservas ──
        const variantReads = [];
        for (const item of items) {
          if (item.supplyType === "stock_propio") {
            const variantRef = db
              .collection("products")
              .doc(item.productId)
              .collection("variants")
              .doc(item.variantId);
            variantReads.push({ ref: variantRef, item });
          }
        }

        // Leer todas las variantes que necesitan reserva
        const variantSnaps = [];
        for (const { ref, item } of variantReads) {
          const snap = await transaction.get(ref);
          if (!snap.exists) {
            throw new HttpsError(
              "not-found",
              `Variante no encontrada: ${item.variantName || item.variantId}`
            );
          }
          variantSnaps.push({ ref, snap, item });
        }

        // Validar disponibilidad
        for (const { snap, item } of variantSnaps) {
          const data = snap.data();
          const available = (data.stock || 0) - (data.reservedStock || 0);
          if (available < item.quantity) {
            throw new HttpsError(
              "failed-precondition",
              `Stock insuficiente para "${item.productName} - ${item.variantName}". ` +
              `Disponible: ${available}, solicitado: ${item.quantity}.`
            );
          }
        }

        // ── 2. Reservar stock ──
        for (const { ref } of variantSnaps) {
          const item = variantSnaps.find(v => v.ref.path === ref.path).item;
          transaction.update(ref, {
            reservedStock: FieldValue.increment(item.quantity),
          });
        }

        // ── 3. Calcular montos de bajo pedido ──
        let depositTotal = 0;
        let hasBackorderItems = false;

        const orderItems = items.map((item) => {
          const itemSubtotal = item.price * item.quantity;
          const isBajoPedido = item.supplyType === "bajo_pedido";
          const depositAmount = isBajoPedido
            ? Math.round(itemSubtotal * BACKORDER_DEPOSIT_PERCENT)
            : 0;

          if (isBajoPedido) {
            hasBackorderItems = true;
            depositTotal += depositAmount;
          }

          return {
            productId: item.productId,
            variantId: item.variantId,
            productName: item.productName,
            variantName: item.variantName,
            imageUrl: item.imageUrl || "",
            price: item.price,
            quantity: item.quantity,
            subtotal: itemSubtotal,
            supplyType: item.supplyType || "stock_propio",
            depositAmount,
            depositPaid: false,
            remainingPaid: false,
          };
        });

        const total = subtotal + shippingCost;
        const remainingTotal = hasBackorderItems ? total - depositTotal : 0;

        // ── 4. Crear orden ──
        const orderRef = db.collection("orders").doc(orderId);
        transaction.set(orderRef, {
          orderNumber,
          customerUid,
          customerEmail: customerEmail || "",
          customerName,
          customerPhone: customerPhone || "",
          status: "pendiente_pago",
          paymentStatus: "pendiente",
          paymentMethod,
          paymentProofUrl: "",
          paymentPhone: paymentPhone || "",
          paymentTransactionId: "",
          paymentAmount: 0,
          paymentDate: "",
          subtotal,
          shippingCost,
          total,
          shippingType: shippingType || "normal",
          shippingAddress: shippingAddress || {},
          trackingNumber: "",
          trackingUrl: "",
          hasBackorderItems,
          depositTotal,
          remainingTotal,
          depositStatus: hasBackorderItems ? "pendiente" : "no_aplica",
          remainingStatus: hasBackorderItems ? "pendiente" : "no_aplica",
          backorderDepositPaid: false,
          backorderRemainingPaid: false,
          notes: "",
          createdAt: now,
          updatedAt: now,
        });

        // ── 5. Crear sub-items ──
        for (const orderItem of orderItems) {
          const itemRef = db.collection("orders").doc(orderId).collection("items").doc();
          transaction.set(itemRef, orderItem);
        }
      });

      // Actualizar CRM a comprador_potencial
      if (customerUid) {
        await updateCrmOnOrderCreated(customerUid);
      }

      return { orderId, orderNumber };
    } catch (err) {
      // Re-throw HttpsError as-is
      if (err instanceof HttpsError) throw err;
      console.error("Error creating order with reservation:", err);
      throw new HttpsError("internal", "Error al crear el pedido. Intenta de nuevo.");
    }
  }
);

// ==============================================
// TRIGGER: Cambios de estado en pedido
// ==============================================
exports.onOrderStatusChange = onDocumentUpdated(
  { document: "orders/{orderId}", secrets: [telegramBotToken, telegramChatId] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const orderId = event.params.orderId;

    // Solo actuar cuando el estado cambia
    if (before.status === after.status) return;

    try {
      // ── PAGADO: descontar inventario, pasar a por_preparar, notificar ──
      if (after.status === "pagado") {
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

        // Pasar a "por_preparar"
        batch.update(db.collection("orders").doc(orderId), {
          status: "por_preparar",
          updatedAt: new Date().toISOString(),
        });

        await batch.commit();

        // Notificar admins por Telegram
        const message = `🛒 *Nuevo pedido pagado*\n\n` +
          `📦 Orden: ${after.orderNumber}\n` +
          `👤 Cliente: ${after.customerName}\n` +
          `💰 Total: ₡${after.total?.toLocaleString()}\n` +
          `💳 Método: ${after.paymentMethod}`;

        await notifyAdminsTelegram(message, {
          telegramBotToken,
          telegramChatId,
        });

        // Actualizar CRM
        await updateCrmOnOrderPaid(after, orderId);
      }

      // ── ENVIADO: registrar automatización tracking ──
      if (after.status === "enviado" && after.trackingNumber) {
        await logAutomation({
          type: "post_sale_tracking",
          targetUid: after.customerUid,
          orderId,
          channel: "whatsapp",
          metadata: {
            customerName: after.customerName,
            customerPhone: after.customerPhone,
            orderNumber: after.orderNumber,
            trackingNumber: after.trackingNumber,
            trackingUrl: after.trackingUrl || "",
          },
        });
      }

      // ── ENTREGADO: registrar automatización reseña ──
      if (after.status === "entregado") {
        // Programar para 2 días después
        const reviewDate = new Date();
        reviewDate.setDate(reviewDate.getDate() + 2);

        await logAutomation({
          type: "post_sale_review",
          targetUid: after.customerUid,
          orderId,
          scheduledAt: reviewDate.toISOString(),
          channel: "whatsapp",
          metadata: {
            customerName: after.customerName,
            customerPhone: after.customerPhone,
            orderNumber: after.orderNumber,
          },
        });
      }

      // ── CANCELADO: liberar reservedStock si venía de pendiente_pago ──
      if (after.status === "cancelado" && before.status === "pendiente_pago") {
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
              reservedStock: FieldValue.increment(-item.quantity),
            });
          }
        }

        await batch.commit();
      }
    } catch (err) {
      console.error(`Error processing order status change (${orderId}):`, err);
    }
  }
);
