const { onSchedule } = require("firebase-functions/v2/scheduler");
const { db } = require("./utils");

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
      try {
        const expired = await db.runTransaction(async (transaction) => {
          const orderRef = db.collection("orders").doc(orderDoc.id);
          const current = await transaction.get(orderRef);
          if (!current.exists) return false;
          const order = current.data();
          // El snapshot de la consulta puede ser anterior al comienzo de un pago.
          // Este cron solo conserva el flujo LEGACY; nunca expira un intento de pasarela
          // ni interviene reservas/fulfillment con los nuevos marcadores del servidor.
          if (order.status !== "pendiente_pago" || typeof order.createdAt !== "string"
              || !Number.isFinite(Date.parse(order.createdAt)) || Date.parse(order.createdAt) >= Date.parse(todayStart)
              || order.paymentMethod === "tilopay" || Object.prototype.hasOwnProperty.call(order, "tilopay")
              || order.paymentMethod === "paypal" || Object.prototype.hasOwnProperty.call(order, "paypal")
              || Object.prototype.hasOwnProperty.call(order, "inventoryReservation")
              || Object.prototype.hasOwnProperty.call(order, "fulfillment")
              || ["pagado", "verificado", "test_paid", "reembolsado", "refunded"].includes(order.paymentStatus)
              || order.legacyReservationReleasedAt) return false;
          if (!Array.isArray(order.reservedItems) || order.reservedItems.length > 50) return false;

          // Agrupar duplicados antes de leer/escribir una variante; nunca aplicar dos
          // incrementos contra la misma disponibilidad ni aceptar cantidades negativas.
          const grouped = new Map();
          for (const item of order.reservedItems) {
            if (!item || typeof item.productId !== "string" || typeof item.variantId !== "string"
                || !/^[A-Za-z0-9_-]{1,128}$/.test(item.productId) || !/^[A-Za-z0-9_-]{1,128}$/.test(item.variantId)
                || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 99) {
              throw new Error("Reserva legacy inválida; requiere revisión manual");
            }
            const key = JSON.stringify([item.productId, item.variantId]);
            const line = grouped.get(key) || { productId: item.productId, variantId: item.variantId, quantity: 0 };
            line.quantity += item.quantity;
            grouped.set(key, line);
          }
          const releases = [];
          for (const item of grouped.values()) {
            const ref = db.collection("products").doc(item.productId).collection("variants").doc(item.variantId);
            const variant = await transaction.get(ref);
            if (!variant.exists) throw new Error("Variante legacy no encontrada; no se libera stock");
            const data = variant.data();
            const stock = data.stock ?? 0;
            const reservedStock = data.reservedStock ?? 0;
            if (!Number.isSafeInteger(stock) || !Number.isSafeInteger(reservedStock)
                || stock < 0 || reservedStock < item.quantity || reservedStock > stock) {
              throw new Error("Stock reservado legacy inconsistente; requiere revisión manual");
            }
            releases.push({ ref, reservedStock: reservedStock - item.quantity });
          }
          // Ninguna escritura se realiza hasta terminar y validar todas las lecturas.
          for (const release of releases) transaction.update(release.ref, { reservedStock: release.reservedStock });
          transaction.update(orderRef, {
            status: "expirado", legacyReservationReleasedAt: now.toISOString(), updatedAt: now.toISOString(),
          });
          return true;
        });
        if (expired) console.log(`Order ${orderDoc.id} expired and stock released.`);
      } catch (error) {
        // Transacción fallida = ningún descuento ni estado expirado parcial.
        console.error(`Error expiring legacy reservation ${orderDoc.id}:`, error.message);
      }
    }
  }
);
