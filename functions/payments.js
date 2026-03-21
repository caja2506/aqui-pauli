const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { db, FieldValue, logMessage } = require("./utils");

const paypalClientId = defineSecret("PAYPAL_CLIENT_ID");
const paypalSecret = defineSecret("PAYPAL_SECRET");

// ==============================================
// CALLABLE: Conciliación de pagos (mejorada)
// ==============================================
/**
 * Reglas de match 100%:
 *
 * SINPE Móvil:
 *   - phone: debe coincidir exactamente con order.paymentPhone
 *   - amount: tolerancia de ±₡1 (por redondeo SINPE)
 *   - date: debe ser del mismo día (YYYY-MM-DD)
 *   Razón tolerancia: SINPE redondea montos a colón entero.
 *
 * Transferencia Bancaria:
 *   - phone: debe coincidir exactamente con order.paymentPhone
 *   - amount: tolerancia de ±₡1
 *   - date: debe ser del mismo día (YYYY-MM-DD)
 *   - transactionId: obligatorio y no vacío
 *   Sin transactionId → revisión manual siempre.
 *
 * PayPal:
 *   Se maneja en capturePayPalOrder (verificación directa con API).
 */
exports.reconcilePayment = onCall(
  { secrets: [], invoker: "public", cors: true },
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

    // Protección contra doble confirmación
    if (order.paymentStatus === "pagado") {
      return { result: "already_paid", message: "Este pedido ya fue marcado como pagado." };
    }

    const { amount, phone, date, transactionId, method } = paymentData;
    const paymentMethod = method || order.paymentMethod;

    // ── Evaluar match según método ──
    let isFullMatch = false;
    let matchDetails = {};

    // Match de monto: tolerancia ₡1
    const amountMatch = Math.abs((amount || 0) - order.total) <= 1;
    matchDetails.amountMatch = amountMatch;
    matchDetails.amountDiff = Math.abs((amount || 0) - order.total);

    // Match de teléfono
    const phoneMatch = !order.paymentPhone || phone === order.paymentPhone;
    matchDetails.phoneMatch = phoneMatch;

    // Match de fecha (mismo día)
    const orderDate = order.createdAt?.substring(0, 10); // YYYY-MM-DD
    const payDate = date?.substring(0, 10);
    const dateMatch = !orderDate || !payDate || orderDate === payDate;
    matchDetails.dateMatch = dateMatch;

    if (paymentMethod === "sinpe") {
      // SINPE: phone + amount + date
      isFullMatch = amountMatch && phoneMatch && dateMatch;
      matchDetails.method = "sinpe";
      matchDetails.rules = "phone + amount(±₡1) + date(mismo día)";
    } else if (paymentMethod === "transferencia") {
      // Transferencia: phone + amount + date + transactionId obligatorio
      const hasTransactionId = !!transactionId && transactionId.trim().length > 0;
      matchDetails.hasTransactionId = hasTransactionId;
      isFullMatch = amountMatch && phoneMatch && dateMatch && hasTransactionId;
      matchDetails.method = "transferencia";
      matchDetails.rules = "phone + amount(±₡1) + date + transactionId(obligatorio)";

      if (!hasTransactionId) {
        matchDetails.failReason = "transactionId vacío o ausente — revisión manual obligatoria";
      }
    } else {
      // Otros métodos → revisión manual
      matchDetails.method = paymentMethod;
      matchDetails.rules = "método no soportado para auto-conciliación";
      isFullMatch = false;
    }

    const now = new Date().toISOString();

    if (isFullMatch) {
      // 100% match → auto-aprobar
      await db.collection("orders").doc(orderId).update({
        paymentStatus: "pagado",
        status: "pagado",
        paymentAmount: amount,
        paymentPhone: phone || order.paymentPhone || "",
        paymentTransactionId: transactionId || "",
        paymentDate: date || now,
        reconciliationResult: "auto_approved",
        reconciliationDetails: matchDetails,
        updatedAt: now,
      });
      return { result: "auto_approved", message: "Pago verificado automáticamente.", matchDetails };
    } else {
      // No match → revisión manual
      await db.collection("orders").doc(orderId).update({
        paymentStatus: "verificando",
        status: "revision_manual",
        paymentAmount: amount || 0,
        paymentPhone: phone || order.paymentPhone || "",
        paymentTransactionId: transactionId || "",
        paymentDate: date || now,
        reconciliationResult: "manual_review",
        reconciliationDetails: matchDetails,
        updatedAt: now,
      });
      return { result: "manual_review", message: "Enviado a revisión manual.", matchDetails };
    }
  }
);

// ==============================================
// CALLABLE: Captura de pago PayPal
// ==============================================
/**
 * Verifica un pago PayPal usando la API de órdenes de PayPal.
 * Protege contra doble confirmación.
 * Si PAYPAL_CLIENT_ID y PAYPAL_SECRET no están configurados,
 * funciona como stub con log.
 */
exports.capturePayPalOrder = onCall(
  { secrets: [paypalClientId, paypalSecret], invoker: "public", cors: true },
  async (request) => {
    const { orderId, paypalOrderId } = request.data;

    if (!orderId || !paypalOrderId) {
      throw new HttpsError("invalid-argument", "orderId y paypalOrderId requeridos.");
    }

    const orderSnap = await db.collection("orders").doc(orderId).get();
    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Pedido no encontrado.");
    }

    const order = orderSnap.data();

    // Protección contra doble confirmación
    if (order.paymentStatus === "pagado") {
      return { result: "already_paid", message: "Este pedido ya fue pagado." };
    }

    const clientId = paypalClientId.value();
    const secret = paypalSecret.value();
    const now = new Date().toISOString();

    if (!clientId || !secret) {
      // STUB: sin credenciales PayPal configuradas
      console.log(`[PayPal STUB] orderId: ${orderId}, paypalOrderId: ${paypalOrderId}`);
      await db.collection("orders").doc(orderId).update({
        paymentStatus: "verificando",
        status: "revision_manual",
        paymentTransactionId: paypalOrderId,
        paymentDate: now,
        notes: "PayPal stub — credenciales no configuradas. Requiere verificación manual.",
        updatedAt: now,
      });
      return {
        result: "stub",
        message: "PayPal no configurado. Pedido enviado a revisión manual.",
      };
    }

    try {
      // 1. Obtener access token de PayPal
      const isProduction = clientId.startsWith("A"); // PayPal live keys start with 'A'
      const baseUrl = isProduction
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com";

      const authResponse = await fetch(`${baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });

      const authData = await authResponse.json();
      if (!authResponse.ok) {
        throw new Error(`PayPal auth error: ${authData.error_description || "Unknown"}`);
      }

      // 2. Capturar la orden PayPal
      const captureResponse = await fetch(`${baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${authData.access_token}`,
          "Content-Type": "application/json",
        },
      });

      const captureData = await captureResponse.json();

      if (captureData.status === "COMPLETED") {
        // Extraer monto capturado
        const capture = captureData.purchase_units?.[0]?.payments?.captures?.[0];
        const capturedAmount = parseFloat(capture?.amount?.value || 0);

        await db.collection("orders").doc(orderId).update({
          paymentStatus: "pagado",
          status: "pagado",
          paymentAmount: capturedAmount,
          paymentTransactionId: paypalOrderId,
          paymentDate: now,
          reconciliationResult: "paypal_captured",
          reconciliationDetails: {
            method: "paypal",
            paypalOrderId,
            captureId: capture?.id || "",
            capturedAmount,
            currency: capture?.amount?.currency_code || "USD",
          },
          updatedAt: now,
        });

        return {
          result: "captured",
          message: "Pago PayPal capturado exitosamente.",
          captureId: capture?.id,
        };
      } else {
        // Estado inesperado
        await db.collection("orders").doc(orderId).update({
          paymentStatus: "verificando",
          status: "revision_manual",
          paymentTransactionId: paypalOrderId,
          paymentDate: now,
          notes: `PayPal status: ${captureData.status}. Requiere revisión.`,
          updatedAt: now,
        });

        return {
          result: "manual_review",
          message: `PayPal devolvió status: ${captureData.status}. Enviado a revisión.`,
        };
      }
    } catch (err) {
      console.error("Error capturing PayPal order:", err);
      // No marcar como fallido — dejar en verificando
      await db.collection("orders").doc(orderId).update({
        paymentStatus: "verificando",
        status: "revision_manual",
        paymentTransactionId: paypalOrderId,
        notes: `Error PayPal: ${err.message}`,
        updatedAt: now,
      });
      throw new HttpsError("internal", `Error verificando PayPal: ${err.message}`);
    }
  }
);

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
