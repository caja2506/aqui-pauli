const { onSchedule } = require("firebase-functions/v2/scheduler");
const { db, FieldValue } = require("./utils");

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
