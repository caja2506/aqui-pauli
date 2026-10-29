// Inventario y CRM del pedido: una única transacción con evidencia persistente.
// Los avisos externos se reclaman por separado; un envío ambiguo requiere revisión,
// porque Telegram/SMTP no ofrecen una transacción atómica con Firestore.
const { snapshotFingerprint } = require("./tilopayOrder");
const { parseMinorCRC } = require("./paymentMoney");
const { normalizeInventoryStock } = require("./inventoryStock");
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const hasTilopay = (order) => order?.paymentMethod === "tilopay" || own(order, "tilopay");
const isPaidState = (order) => ["pagado", "verificado"].includes(order?.paymentStatus)
  || ["pagado", "por_preparar", "enviado", "entregado"].includes(order?.status);
const CLOSED_STATUSES = new Set(["cancelado", "reembolsado", "devuelto"]);
const isTerminalOrder = (order) => CLOSED_STATUSES.has(order?.status)
  || ["reembolsado", "refunded", "test_paid"].includes(order?.paymentStatus);

function validDocumentId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && !value.includes("/") && value !== "." && value !== "..";
}

function moneyMinor(value) {
  return parseMinorCRC(value, { allowZero: true });
}

function normalizeLines(lines, { priced = false } = {}) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 50) throw new Error("Líneas de pedido inválidas");
  const seen = new Set();
  return lines.map((line) => {
    if (!validDocumentId(line?.productId) || !validDocumentId(line?.variantId)
        || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) {
      throw new Error("Producto o cantidad inválidos");
    }
    const key = JSON.stringify([line.productId, line.variantId]);
    if (seen.has(key)) throw new Error("El pedido contiene variantes duplicadas");
    seen.add(key);
    const supplyType = line.supplyType || "stock_propio";
    if (!["stock_propio", "bajo_pedido"].includes(supplyType)) throw new Error("Origen de inventario inválido");
    const normalized = { ...line, supplyType };
    if (priced) {
      const unitMinor = moneyMinor(line.unitPrice);
      const totalMinor = moneyMinor(line.lineTotal);
      if (unitMinor <= 0 || totalMinor !== unitMinor * line.quantity) throw new Error("Línea de pago inconsistente");
      normalized.price = unitMinor / 100;
      normalized.unitPrice = unitMinor / 100;
      normalized.lineTotal = totalMinor / 100;
    }
    return normalized;
  });
}

function reservationLines(order) {
  const reservation = order.inventoryReservation;
  if (!reservation) return [];
  if (reservation.version !== 1 || !["reserved", "released", "consumed"].includes(reservation.state)) {
    throw new Error("Marcador de reserva desconocido; requiere revisión");
  }
  if (reservation.state !== "reserved") return [];
  if (Array.isArray(reservation.lines) && reservation.lines.length === 0) return [];
  const lines = normalizeLines(reservation.lines.map((line) => ({ ...line, supplyType: "stock_propio" })));
  return lines;
}

function sameQuantities(left, right) {
  const canon = (lines) => lines.map((line) => [line.productId, line.variantId, line.quantity])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(canon(left)) === JSON.stringify(canon(right));
}

function checkedStock(data) {
  return normalizeInventoryStock(data, { context: "fulfillment" });
}

function paidTilopaySnapshot(order) {
  if (order.tilopay?.reconciliationNeedsReview || order.tilopay?.duplicatePaymentNeedsReview || order.tilopay?.legacyNeedsReview) {
    throw new Error("El pago tiene movimientos pendientes de revisión; no se prepara automáticamente");
  }
  const key = order.tilopay?.paidAttemptKey;
  const attempt = key && order.tilopay?.attemptsById?.[key];
  const snapshot = attempt?.snapshot;
  if (!attempt || attempt.schemaVersion !== 2 || attempt.mode !== "live" || attempt.status !== "approved"
      || attempt.financialEvidence !== "captured" || attempt.reconciliationNeedsReview
      || !snapshot || snapshot.version !== 1 || typeof attempt.orderVersion !== "string" || !attempt.orderVersion) {
    throw new Error("Pago Tilopay sin snapshot live verificado; no se prepara automáticamente");
  }
  if (snapshotFingerprint(snapshot) !== attempt.orderVersion) throw new Error("La huella del snapshot no coincide con el intento acreditado");
  if (!snapshot.shippingAddress || typeof snapshot.shippingAddress !== "object" || Array.isArray(snapshot.shippingAddress)
      || !["normal", "express"].includes(snapshot.shippingType)) throw new Error("Dirección o modalidad de entrega inválida");
  const owner = order.uid || order.customerUid;
  if (!owner || snapshot.ownerUid !== owner || (order.uid && order.customerUid && order.uid !== order.customerUid)) {
    throw new Error("El dueño no coincide con el snapshot de pago");
  }
  if (!String(order.paymentTransactionId || "").trim() || !String(attempt.idTilopay || "").trim()
      || String(order.paymentTransactionId) !== String(attempt.idTilopay)) {
    throw new Error("El identificador del pago no coincide con el intento acreditado");
  }
  if (![snapshot.amountMinor, snapshot.subtotalMinor, snapshot.shippingMinor].every(Number.isSafeInteger)
      || snapshot.amountMinor <= 0 || snapshot.subtotalMinor < 0 || snapshot.shippingMinor < 0
      || snapshot.amountMinor !== snapshot.subtotalMinor + snapshot.shippingMinor
      || snapshot.currency !== "CRC" || snapshot.amountMinor !== attempt.validatedAmountMinor
      || snapshot.amountMinor !== moneyMinor(order.paymentAmount)) {
    throw new Error("El importe acreditado no coincide con el snapshot");
  }
  const lines = normalizeLines(snapshot.lines, { priced: true });
  if (lines.reduce((sum, line) => sum + moneyMinor(line.lineTotal), 0) !== snapshot.subtotalMinor) {
    throw new Error("El subtotal no coincide con las líneas cobradas");
  }
  return {
    lines, paidAttemptKey: key,
    order: { ...order, customerUid: owner, uid: owner, total: snapshot.amountMinor / 100,
      customerName: snapshot.customer?.name || order.customerName || "",
      customerEmail: snapshot.customer?.email || order.customerEmail || "",
      customerPhone: snapshot.customer?.phone || order.customerPhone || "",
      subtotal: snapshot.subtotalMinor / 100, shippingCost: snapshot.shippingMinor / 100,
      shippingType: snapshot.shippingType, shippingAddress: snapshot.shippingAddress },
  };
}

async function readVariants(db, transaction, lines) {
  const variants = [];
  for (const line of lines) {
    const ref = db.collection("products").doc(line.productId).collection("variants").doc(line.variantId);
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new Error(`Variante no encontrada: ${line.productId}/${line.variantId}`);
    variants.push({ ref, line, ...checkedStock(snap.data()) });
  }
  return variants;
}

/** Todas las lecturas y validaciones ocurren antes de escribir stock, CRM o pedido. */
async function applyPaidOrder({ db, orderId, crmDefaults = {} }) {
  const orderRef = db.collection("orders").doc(orderId);
  return db.runTransaction(async (transaction) => {
    const orderSnap = await transaction.get(orderRef);
    if (!orderSnap.exists) return { kind: "missing" };
    const order = orderSnap.data();
    if (order.status !== "pagado" || isTerminalOrder(order)) return { kind: "noop" };
    if (order.fulfillment?.state === "applied") return { kind: "already_applied" };
    const now = new Date().toISOString();
    const review = (reason) => {
      transaction.update(orderRef, { status: "revision_manual", updatedAt: now,
        fulfillment: { version: 1, state: "needs_review", reason, checkedAt: now } });
      return { kind: "review", reason };
    };
    if (!["pagado", "verificado"].includes(order.paymentStatus)) return review("Falta un pago acreditado por el servidor");

    let paid;
    let stockLines;
    let reservedLines;
    let variants;
    try {
      if (hasTilopay(order)) {
        paid = paidTilopaySnapshot(order);
      } else {
        const items = await transaction.get(orderRef.collection("items"));
        const lines = normalizeLines(items.docs.map((doc) => doc.data()));
        paid = { lines, order: { ...order, total: moneyMinor(order.total) / 100, customerUid: order.customerUid || order.uid } };
      }
      stockLines = paid.lines.filter((line) => line.supplyType === "stock_propio");
      reservedLines = reservationLines(order);
      if (order.inventoryReservation && order.inventoryReservation.state !== "reserved") {
        throw new Error("La reserva ya fue liberada o consumida; no se descuenta inventario nuevamente");
      }
      if (order.inventoryReservation && !sameQuantities(stockLines, reservedLines)) {
        throw new Error("La reserva no corresponde a los productos cobrados");
      }
      variants = await readVariants(db, transaction, stockLines);
      for (const variant of variants) {
        const ownReserve = order.inventoryReservation ? variant.line.quantity : 0;
        if (variant.reservedStock < ownReserve || variant.stock - variant.reservedStock + ownReserve < variant.line.quantity) {
          throw new Error("Inventario insuficiente para preparar el pedido; requiere revisión");
        }
      }
    } catch (error) {
      return review(error.message);
    }

    // CRM está en la misma transacción que el marcador de inventario: una compra una vez.
    const owner = paid.order.customerUid;
    let crmRef; let crmSnap; let interactionRef;
    if (owner) {
      crmRef = db.collection("crm_contacts").doc(owner);
      crmSnap = await transaction.get(crmRef);
      interactionRef = crmRef.collection("interactions").doc(`order_${orderId}_paid`);
      await transaction.get(interactionRef);
    }
    for (const variant of variants) {
      const update = { stock: variant.stock - variant.line.quantity };
      if (order.inventoryReservation) update.reservedStock = variant.reservedStock - variant.line.quantity;
      transaction.update(variant.ref, update);
    }
    if (owner) {
      const old = crmSnap.exists ? crmSnap.data() : {};
      const count = (Number.isSafeInteger(old.totalOrders) && old.totalOrders >= 0 ? old.totalOrders : 0) + 1;
      const spent = (Number.isFinite(old.totalSpent) && old.totalSpent >= 0 ? old.totalSpent : 0) + paid.order.total;
      const channels = [...new Set([...(Array.isArray(old.sourceChannels) ? old.sourceChannels : []), "web"])];
      const data = {
        ...(crmSnap.exists ? {} : crmDefaults), uid: owner,
        email: old.email || paid.order.customerEmail || "", displayName: old.displayName || paid.order.customerName || "",
        phone: old.phone || paid.order.customerPhone || "", totalOrders: count, totalSpent: spent,
        funnelStage: count >= 2 ? "recurrente" : "comprador", sourceChannels: channels,
        lastOrderDate: now, lastInteractionAt: now, updatedAt: now,
        ...(!crmSnap.exists ? { source: "compra", createdAt: now } : {}),
      };
      transaction.set(crmRef, data, { merge: true });
      transaction.set(interactionRef, {
        type: "compra", channel: "web", orderId, amount: paid.order.total, createdAt: now,
        description: `Pedido ${paid.order.orderNumber || orderId} pagado — ₡${paid.order.total}`,
        metadata: { orderNumber: paid.order.orderNumber || orderId, paymentMethod: paid.order.paymentMethod || "",
          hasBackorderItems: paid.lines.some((line) => line.supplyType === "bajo_pedido") },
      });
    }
    const update = {
      status: "por_preparar", updatedAt: now,
      fulfillment: { version: 1, state: "applied", inventoryAppliedAt: now, crmAppliedAt: now,
        paymentTransactionId: String(order.paymentTransactionId || ""),
        ...(paid.paidAttemptKey ? { paidAttemptKey: paid.paidAttemptKey } : {}) },
    };
    if (hasTilopay(order)) Object.assign(update, {
      shippingAddress: paid.order.shippingAddress, shippingType: paid.order.shippingType,
      total: paid.order.total, subtotal: paid.order.subtotal, shippingCost: paid.order.shippingCost,
    });
    if (order.inventoryReservation) update.inventoryReservation = { ...order.inventoryReservation, state: "consumed", consumedAt: now };
    transaction.update(orderRef, update);
    return { kind: "applied" };
  });
}

/** Devuelve el plan; el caller escribe después de terminar todas sus lecturas. */
async function reservationReleasePlan({ db, transaction, order }) {
  const lines = reservationLines(order);
  if (!lines.length) return [];
  const variants = await readVariants(db, transaction, lines);
  for (const variant of variants) {
    if (variant.reservedStock < variant.line.quantity) throw new Error("Reserva inconsistente; no se libera automáticamente");
  }
  return variants;
}

async function releaseCancelledReservation({ db, orderId }) {
  const ref = db.collection("orders").doc(orderId);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return { kind: "missing" };
    const order = snap.data();
    if (order.status !== "cancelado" || order.inventoryReservation?.state !== "reserved") return { kind: "noop" };
    if (order.fulfillment?.state === "applied") return { kind: "noop" };
    const variants = await reservationReleasePlan({ db, transaction, order });
    for (const variant of variants) transaction.update(variant.ref, { reservedStock: variant.reservedStock - variant.line.quantity });
    const now = new Date().toISOString();
    transaction.update(ref, { inventoryReservation: { ...order.inventoryReservation, state: "released", releasedAt: now }, updatedAt: now });
    return { kind: "released" };
  });
}

// El aviso de revisión informa una captura ya acreditada; no autoriza entrega.
// No exige un snapshot íntegro: su inconsistencia puede ser precisamente el motivo
// de revisión. Los productos dudosos no se presentan como listos para preparar.
function paidReviewNotice(order) {
  if (order.status !== "revision_manual" || !["pagado", "verificado"].includes(order.paymentStatus)
      || isTerminalOrder(order)) return null;
  let total;
  let attempt;
  if (hasTilopay(order)) {
    const key = order.tilopay?.paidAttemptKey;
    attempt = key && order.tilopay?.attemptsById?.[key];
    if (order.tilopay?.mode === "test" || !attempt || attempt.schemaVersion !== 2
        || attempt.mode !== "live" || attempt.status !== "approved" || attempt.financialEvidence !== "captured"
        || !Number.isSafeInteger(attempt.validatedAmountMinor) || attempt.validatedAmountMinor <= 0
        || !String(attempt.idTilopay || "").trim()
        || String(attempt.idTilopay) !== String(order.paymentTransactionId || "")) return null;
    total = attempt.validatedAmountMinor / 100;
  } else {
    try { total = moneyMinor(order.paymentAmount || order.total) / 100; } catch { return null; }
    if (total <= 0) return null;
  }
  const reason = order.fulfillment?.reason || attempt?.reason
    || "El pago está acreditado y el pedido requiere revisión administrativa.";
  return { order: { ...order, total }, lines: [], requiresReview: true,
    reviewReason: String(reason).slice(0, 300) };
}

function effectState(effects, channel, kind) {
  return kind === "review" ? effects?.review?.[channel] : effects?.[channel];
}

function withEffect(effects, channel, kind, effect) {
  return kind === "review"
    ? { ...(effects || {}), review: { ...(effects?.review || {}), [channel]: effect } }
    : { ...(effects || {}), [channel]: effect };
}

async function claimPaidEffect({ db, orderId, channel, kind = "paid" }) {
  if (!["telegram", "email"].includes(channel) || !["paid", "review"].includes(kind)) throw new Error("Aviso inválido");
  const ref = db.collection("orders").doc(orderId);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return null;
    const order = snap.data();
    // Cada tipo de aviso se reclama de forma independiente. Un aviso normal previo
    // no oculta la revisión, y resolver una revisión no suprime el aviso de preparación.
    if (effectState(order.paidEffects, channel, kind)) return null;
    let paid;
    if (kind === "review") {
      paid = paidReviewNotice(order);
      if (!paid) return null;
    } else {
      if (order.fulfillment?.state !== "applied" || !isPaidState(order) || isTerminalOrder(order)
          || !["pagado", "por_preparar", "enviado", "entregado"].includes(order.status)) return null;
      if (hasTilopay(order)) {
        try { paid = paidTilopaySnapshot(order); } catch { return null; }
      } else {
        const items = await transaction.get(ref.collection("items"));
        paid = { order, lines: normalizeLines(items.docs.map((doc) => doc.data())) };
      }
    }
    // sending/needs_review se resuelven manualmente; nunca reenviar a ciegas.
    transaction.update(ref, { paidEffects: withEffect(order.paidEffects, channel, kind,
      { state: "sending", startedAt: new Date().toISOString() }) });
    return { order: paid.order, items: paid.lines,
      ...(paid.requiresReview ? { requiresReview: true, reviewReason: paid.reviewReason } : {}) };
  });
}

async function finishPaidEffect({ db, orderId, channel, state, reason, kind = "paid" }) {
  if (!["telegram", "email"].includes(channel) || !["paid", "review"].includes(kind)) throw new Error("Aviso inválido");
  const ref = db.collection("orders").doc(orderId);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const data = snap.data();
    const effect = effectState(data.paidEffects, channel, kind);
    if (effect?.state !== "sending") return;
    transaction.update(ref, { paidEffects: withEffect(data.paidEffects, channel, kind, {
      ...effect, state, finishedAt: new Date().toISOString(), ...(reason ? { reason: String(reason).slice(0, 300) } : {}),
    }) });
  });
}

module.exports = { hasTilopay, isPaidState, isTerminalOrder, validDocumentId, moneyMinor, normalizeLines,
  checkedStock, paidTilopaySnapshot, applyPaidOrder, reservationReleasePlan, releaseCancelledReservation,
  claimPaidEffect, finishPaidEffect };
