const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db } = require("./utils");

// ==============================================
// CALLABLE: Subida de comprobante de pago
// ==============================================
/**
 * Recibe la URL del comprobante (ya subido a Storage desde el frontend)
 * y la asocia al pedido. Cambia paymentStatus a "verificando".
 *
 * Para subida directa desde frontend:
 *   1. Frontend sube a Firebase Storage path: `payment_proofs/{orderId}/{filename}`
 *   2. Frontend obtiene la downloadURL
 *   3. Frontend llama este callable con la URL
 *
 * También soporta datos adicionales de pago para conciliación.
 */
exports.submitPaymentProof = onCall(
  { secrets: [], invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const { orderId, proofUrl, paymentPhone, transactionId, amount, date } = request.data;

    if (!orderId) {
      throw new HttpsError("invalid-argument", "orderId requerido.");
    }

    const orderSnap = await db.collection("orders").doc(orderId).get();
    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Pedido no encontrado.");
    }

    const order = orderSnap.data();

    // Verificar que el usuario sea el dueño del pedido
    if (order.customerUid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "No tienes acceso a este pedido.");
    }

    // Protección contra doble envío si ya pagado
    if (order.paymentStatus === "pagado") {
      return { result: "already_paid", message: "Este pedido ya fue marcado como pagado." };
    }

    const now = new Date().toISOString();

    const updateData = {
      paymentStatus: "verificando",
      updatedAt: now,
    };

    if (proofUrl) updateData.paymentProofUrl = proofUrl;
    if (paymentPhone) updateData.paymentPhone = paymentPhone;
    if (transactionId) updateData.paymentTransactionId = transactionId;
    if (amount) updateData.paymentAmount = amount;
    if (date) updateData.paymentDate = date;

    await db.collection("orders").doc(orderId).update(updateData);

    return {
      result: "submitted",
      message: "Comprobante enviado. Será verificado por el equipo.",
    };
  }
);

// ==============================================
// CALLABLE: Aprobación manual de pago (solo admin)
// ==============================================
exports.approvePaymentManually = onCall(
  { secrets: [], invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const { orderId, notes } = request.data;

    if (!orderId) {
      throw new HttpsError("invalid-argument", "orderId requerido.");
    }

    // Verificar que sea admin
    const userRoleSnap = await db.collection("users_roles").doc(request.auth.uid).get();
    if (!userRoleSnap.exists || userRoleSnap.data().role !== "admin") {
      throw new HttpsError("permission-denied", "Solo administradores pueden aprobar pagos.");
    }

    const orderSnap = await db.collection("orders").doc(orderId).get();
    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Pedido no encontrado.");
    }

    const order = orderSnap.data();

    if (order.paymentStatus === "pagado") {
      return { result: "already_paid", message: "Este pedido ya fue pagado." };
    }

    const now = new Date().toISOString();

    await db.collection("orders").doc(orderId).update({
      paymentStatus: "pagado",
      status: "pagado",
      paymentDate: order.paymentDate || now,
      paymentAmount: order.paymentAmount || order.total,
      reconciliationResult: "manual_approved",
      reconciliationDetails: {
        approvedBy: request.auth.uid,
        approvedAt: now,
        notes: notes || "",
      },
      updatedAt: now,
    });

    return { result: "approved", message: "Pago aprobado manualmente." };
  }
);
