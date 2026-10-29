const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db } = require("./utils");
const { hasTilopay, isPaidState, isTerminalOrder, validDocumentId, moneyMinor } = require("./lib/orderFulfillment");

function assertManualFlow(order) {
  if (hasTilopay(order)) {
    throw new HttpsError("failed-precondition", "Este pedido usa Tilopay. Confirma el pago con tilopayConfirm; un comprobante o una aprobación manual no sustituyen la consulta del cobro.");
  }
  if (isTerminalOrder(order)) throw new HttpsError("failed-precondition", "Este pedido está cerrado o es una prueba; no admite este cambio de pago.");
}

exports.submitPaymentProof = onCall(
  { secrets: [], invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    const { orderId, proofUrl, paymentPhone, transactionId, amount, date } = request.data || {};
    if (!validDocumentId(orderId)) throw new HttpsError("invalid-argument", "orderId requerido.");
    let normalizedAmount;
    if (amount !== undefined && amount !== null && amount !== "") {
      try { normalizedAmount = moneyMinor(amount) / 100; }
      catch { throw new HttpsError("invalid-argument", "Monto de comprobante inválido."); }
    }
    return db.runTransaction(async (transaction) => {
      const ref = db.collection("orders").doc(orderId);
      const snap = await transaction.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
      const order = snap.data();
      if (order.customerUid !== request.auth.uid && order.uid !== request.auth.uid) {
        throw new HttpsError("permission-denied", "No tienes acceso a este pedido.");
      }
      assertManualFlow(order);
      if (isPaidState(order)) return { result: "already_paid", message: "Este pedido ya fue marcado como pagado." };
      if (!["pendiente_pago", "revision_manual"].includes(order.status)) {
        throw new HttpsError("failed-precondition", "El pedido no está esperando un comprobante.");
      }
      const update = { paymentStatus: "verificando", updatedAt: new Date().toISOString() };
      if (typeof proofUrl === "string" && proofUrl) update.paymentProofUrl = proofUrl.slice(0, 4000);
      if (typeof paymentPhone === "string" && paymentPhone) update.paymentPhone = paymentPhone.slice(0, 40);
      if (typeof transactionId === "string" && transactionId) update.paymentTransactionId = transactionId.slice(0, 200);
      if (normalizedAmount !== undefined) update.paymentAmount = normalizedAmount;
      if (typeof date === "string" && date) update.paymentDate = date.slice(0, 50);
      // Estos datos son solo una declaración pendiente; no acreditan dinero ni cambian status a pagado.
      transaction.update(ref, update);
      return { result: "submitted", message: "Comprobante enviado. Será verificado por el equipo." };
    });
  }
);

exports.approvePaymentManually = onCall(
  { secrets: [], invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    const { orderId, notes } = request.data || {};
    if (!validDocumentId(orderId)) throw new HttpsError("invalid-argument", "orderId requerido.");
    return db.runTransaction(async (transaction) => {
      const role = await transaction.get(db.collection("users_roles").doc(request.auth.uid));
      if (!role.exists || role.data().role !== "admin") throw new HttpsError("permission-denied", "Solo administradores pueden aprobar pagos.");
      const ref = db.collection("orders").doc(orderId);
      const snap = await transaction.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
      const order = snap.data();
      assertManualFlow(order);
      if (isPaidState(order)) return { result: "already_paid", message: "Este pedido ya fue pagado." };
      if (!["pendiente_pago", "revision_manual"].includes(order.status)) {
        throw new HttpsError("failed-precondition", "El pedido no admite aprobación de pago.");
      }
      let paymentAmount;
      try { paymentAmount = moneyMinor(order.paymentAmount || order.total) / 100; }
      catch { throw new HttpsError("failed-precondition", "El pedido tiene un monto inválido."); }
      if (paymentAmount <= 0) throw new HttpsError("failed-precondition", "El pedido tiene un monto inválido.");
      const now = new Date().toISOString();
      transaction.update(ref, {
        paymentStatus: "pagado", status: "pagado", paymentDate: order.paymentDate || now,
        paymentAmount, reconciliationResult: "manual_approved",
        reconciliationDetails: { approvedBy: request.auth.uid, approvedAt: now,
          notes: typeof notes === "string" ? notes.slice(0, 2000) : "" },
        updatedAt: now,
      });
      return { result: "approved", message: "Pago aprobado manualmente." };
    });
  }
);
