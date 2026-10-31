"use strict";

const crypto = require("node:crypto");
const defaultApi = require("./tilopayApi");
const { computeTotalsCRC: defaultPricing, PricingError } = require("./pricing");
const { parseMinorCRC, minorToCRC } = require("./paymentMoney");
const { normalizeInventoryStock } = require("./inventoryStock");
const {
  PAYABLE_STATUSES, validDocumentId, orderOwnerUid, isPaidOrder, snapshotFingerprint,
  makeSnapshot, currentSnapshot, canonicalItem, attemptsOf, checkoutLockId,
  validateSnapshotAmounts, quoteFromSnapshot,
} = require("./tilopayOrder");

const SETTLED_LOCKS = new Set(["paid", "test_paid"]);
const FINAL_ATTEMPT_STATES = new Set(["approved", "test_paid"]);
const REVIEW_STATES = new Set(["mismatch", "pending_capture", "pending_reconciliation", "legacy_review"]);
const CONCURRENCY = 4;
const attemptContext = (a) => snapshotFingerprint({
  schemaVersion: a.schemaVersion, orderNumber: a.orderNumber, mode: a.mode,
  merchantId: a.merchantId, orderPrefix: a.orderPrefix, amount: a.amount,
  amountMinor: a.amountMinor, currency: a.currency, keyFingerprint: a.keyFingerprint,
  orderVersion: a.orderVersion, snapshot: a.snapshot,
});

async function mapLimited(values, fn) {
  const output = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await fn(values[index]);
    }
  }));
  return output;
}

function createTilopayService({ db, credentials, returnBase, HttpsError, api = defaultApi,
  computeTotalsCRC = defaultPricing, clock = () => Date.now(), randomId = () => crypto.randomUUID().replace(/-/g, ""),
  onQuoteError = (event) => console.warn(JSON.stringify(event)) }) {
  const fail = (code, message, details) => { throw new HttpsError(code, message, details); };
  const now = () => new Date(clock()).toISOString();
  const orderRef = (id) => db.collection("orders").doc(id);
  const itemsQuery = (ref) => ref.collection("items").limit(51);
  const refDoc = (number) => db.collection("tilopayReferences").doc(snapshotFingerprint({ number }));
  const onlyLiveAttempts = (order) => {
    const attempts = attemptsOf(order);
    return order?.tilopay?.mode === "live" && attempts.length > 0 && attempts.every((a) => a.mode === "live");
  };

  const pilotRef = () => db.collection("_ops").doc("tilopay-live-pilot");
  const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

  function pilotPermits(pilot, request) {
    const { pilotToken, pilotSession } = request?.data || {};
    if (!request?.auth?.uid || pilot?.active !== true || !Number.isSafeInteger(pilot.expiresAt)
      || pilot.expiresAt <= clock() || typeof pilotToken !== "string" || !/^[a-f0-9]{64}$/.test(pilotToken)
      || typeof pilotSession !== "string" || !/^[a-f0-9]{32}$/.test(pilotSession)
      || hash(pilotToken) !== pilot.tokenHash) return false;
    return !pilot.ownerUid || (pilot.ownerUid === request.auth.uid && pilot.sessionHash === hash(pilotSession));
  }

  async function readConfig(transaction) {
    try {
      const ref = db.collection("config").doc("payments");
      const doc = transaction ? await transaction.get(ref) : await ref.get();
      const c = doc.exists ? doc.data().tilopay || {} : {};
      const validMode = c.mode === "test" || c.mode === "live";
      const merchantId = typeof c.merchantId === "string" ? c.merchantId.trim() : "";
      const orderPrefix = typeof c.orderPrefix === "string" ? c.orderPrefix.trim() : "";
      // Test remains usable before the integration exposes a merchant/prefix.
      // Live requires both identities, and every attempt keeps its original mode.
      const identityValid = c.mode === "test" || (/^[A-Za-z0-9_-]{1,100}$/.test(merchantId)
        && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(orderPrefix));
      const pilot = c.access === "private-pilot";
      const validAccess = c.access === undefined || (pilot && c.mode === "live");
      return { enabled: c.enabled === true && validMode && identityValid && validAccess, pilot, seed: c.pilotSeed,
        mode: validMode ? c.mode : "test", merchantId, orderPrefix };
    } catch {
      return { enabled: false, mode: "test", merchantId: "", orderPrefix: "" };
    }
  }

  async function requireTester(uid) {
    const role = await db.collection("users_roles").doc(uid).get();
    if (!role.exists || !["admin", "tester"].includes(role.data().role)) {
      fail("permission-denied", "Esta operación de prueba requiere una cuenta autorizada.");
    }
  }

  function assertOwner(order, uid) {
    let owner;
    try { owner = orderOwnerUid(order); } catch { fail("permission-denied", "Propietario del pedido inconsistente."); }
    if (owner !== uid) fail("permission-denied", "No tienes acceso a este pedido.");
  }

  async function owned(request) {
    if (!request?.auth?.uid) fail("unauthenticated", "Debes iniciar sesión.");
    const id = request.data?.orderId;
    if (!validDocumentId(id)) fail("invalid-argument", "orderId inválido.");
    const ref = orderRef(id);
    const snap = await ref.get();
    if (!snap.exists) fail("not-found", "Pedido no encontrado.");
    assertOwner(snap.data(), request.auth.uid);
    return { ref, id, order: snap.data(), uid: request.auth.uid };
  }

  function configuredCredentials() {
    const c = credentials();
    if (!c?.key || !c.apiUser || !c.password) fail("failed-precondition", "Tilopay no está configurado.");
    return c;
  }

  async function tokenFor(c) {
    try { return await api.getToken({ apiUser: c.apiUser, password: c.password }); }
    catch { fail("unavailable", "No pudimos consultar Tilopay. Conserva este pedido y vuelve a verificarlo."); }
  }

  async function priceSnapshot(order, input, transaction) {
    const totals = await computeTotalsCRC(db, input, {
      canton: order.shippingAddress?.canton, shippingType: order.shippingType,
    }, transaction ? { transaction } : {});
    const lines = totals.lines.map((line) => ({ ...line,
      itemId: input.find((item) => item.productId === line.productId && item.variantId === line.variantId)?.itemId,
    }));
    return makeSnapshot(order, lines, totals);
  }

  function assertExpectedQuote(expected, snapshot) {
    if (expected === undefined) return; // Older clients did not send a displayed quote.
    const actual = quoteFromSnapshot(snapshot);
    let matches = expected && typeof expected === "object" && !Array.isArray(expected)
      && expected.currency === actual.currency && expected.hasBackorder === actual.hasBackorder;
    try {
      for (const key of ["crcTotal", "crcSubtotal", "crcShipping", "crcPayNow", "crcBalanceDue", "crcDepositTotal", "crcBackorderSubtotal"]) {
        matches = matches && parseMinorCRC(expected[key], { allowZero: true }) === parseMinorCRC(actual[key], { allowZero: true });
      }
    } catch { matches = false; }
    if (!matches) fail("failed-precondition", "El importe cambió. Revisá el monto actualizado antes de pagar con tarjeta.", { quote: actual });
  }

  function paymentItems(snapshot, received = false) {
    const amounts = validateSnapshotAmounts(snapshot);
    const deposits = new Map(amounts.depositByItem.map((line) => [line.itemId, line.amountMinor]));
    return snapshot.lines.map((line) => ({ ...canonicalItem(line), itemId: line.itemId,
      depositAmount: minorToCRC(deposits.get(line.itemId) || 0),
      depositPaid: received && line.supplyType === "bajo_pedido",
      remainingPaid: received && (line.supplyType !== "bajo_pedido" || amounts.remainingMinor === 0) }));
  }

  function paymentPlanFields(snapshot, received = false) {
    const quote = quoteFromSnapshot(snapshot);
    return { subtotal: quote.crcSubtotal, shippingCost: quote.crcShipping, total: quote.crcTotal,
      hasBackorder: quote.hasBackorder, hasBackorderItems: quote.hasBackorder,
      backorderSubtotal: quote.crcBackorderSubtotal,
      backorderDeposit: quote.crcDepositTotal, depositTotal: quote.crcDepositTotal,
      payNowTotal: quote.crcPayNow, remainingTotal: quote.crcBalanceDue,
      depositStatus: quote.hasBackorder ? (received ? "pagado" : "pendiente") : "no_aplica",
      remainingStatus: quote.crcBalanceDue > 0 ? "pendiente" : "no_aplica",
      backorderDepositPaid: received && quote.hasBackorder,
      backorderRemainingPaid: received && quote.hasBackorder && quote.crcBalanceDue === 0 };
  }

  function summarize(order, id, justPaid = false) {
    const list = attemptsOf(order);
    const attempt = list.find((a) => a.key === order.tilopay?.paidAttemptKey)
      || list.find((a) => a.key === order.tilopay?.currentAttempt) || list[0];
    let quote = {};
    try { if (attempt?.snapshot) quote = quoteFromSnapshot(attempt.snapshot); } catch { /* No invented legacy amounts. */ }
    const extra = { orderId: id, orderNumber: order.orderNumber || "", currency: "CRC", retry: false,
      ...quote, partial: quote.crcBalanceDue > 0 };
    if (order.tilopay?.duplicatePaymentNeedsReview || order.tilopay?.legacyNeedsReview || order.tilopay?.reconciliationNeedsReview) {
      return { ...extra, result: "review", code: order.tilopay?.duplicatePaymentNeedsReview ? "duplicate_payment"
        : order.tilopay?.legacyNeedsReview ? "legacy_review" : "pending_reconciliation",
      paid: isPaidOrder(order), message: "Hay un movimiento que requiere revisión. Conserva este pedido y no vuelvas a pagar." };
    }
    if (isPaidOrder(order)) return { ...extra, result: justPaid ? "paid" : "already_paid", paid: true,
      message: extra.partial ? "Apartado recibido y verificado. Queda un saldo pendiente." : "Pago recibido y verificado." };
    if (order.paymentStatus === "test_paid") return { ...extra, result: "test_paid", paid: false,
      message: "Transacción de prueba verificada. Este pedido no habilita una entrega real." };
    // An unavailable hosted form is a creation problem. Never present it as a
    // card authorization or grant a retry from an inconclusive consult.
    if (list.length === 1 && attempt.status === "pending_reconciliation" && attempt.creationCheckedAt
      && !attempt.url && !attempt.idTilopay && !attempt.reconciliationNeedsReview) {
      const reason = attempt.creationOutcome?.reason || "FORM_UNCONFIRMED";
      const canRequestTestForm = order.tilopay.mode === "test" && attempt.mode === "test" && attempt.schemaVersion === 2
        && !attempt.formInFlight && attempt.providerOrderAbsent === true && PAYABLE_STATUSES.has(order.status)
        && (reason === "MERCHANT_TRANSACTION_BLOCK" || reason === "FORM_UNCONFIRMED");
      return { ...extra, result: "review", paid: false, code: "pending_reconciliation", formUnavailable: true,
        formReason: reason, ...(canRequestTestForm ? { testFormGeneration: attempt.formGeneration || 0 } : {}),
        message: reason === "MERCHANT_TRANSACTION_BLOCK"
          ? "Tilopay bloqueó los formularios de pago de este comercio. Conservá este pedido."
          : "No se pudo abrir el formulario de Tilopay. Conservá este pedido para consultar el intento." };
    }
    if (list.some((a) => REVIEW_STATES.has(a.status))) return { ...extra, result: "review", paid: false,
      code: list.find((a) => REVIEW_STATES.has(a.status)).status,
      message: "El pago requiere verificación. Puedes consultar nuevamente este mismo pedido." };
    if (list.some((a) => a.status === "declined")) return { ...extra, result: "declined", paid: false,
      message: "Se observó un rechazo. Antes de otro pago debemos resolver este mismo intento." };
    return { ...extra, result: "pending", paid: false,
      message: "El pago sigue pendiente de confirmación. Consulta nuevamente este pedido; no inicies otro cobro." };
  }

  function snapshotMatches(order, docs, attempt) {
    try {
      const amounts = validateSnapshotAmounts(attempt.snapshot);
      return attempt.schemaVersion === 2 && attempt.amountMinor === amounts.amountMinor
        && parseMinorCRC(attempt.amount) === amounts.amountMinor
        && snapshotFingerprint(attempt.snapshot) === attempt.orderVersion
        && snapshotFingerprint(currentSnapshot(order, docs, attempt.snapshot)) === attempt.orderVersion;
    } catch { return false; }
  }

  async function reserve(ctx, cfg, c, expectedQuote, request) {
    const tokenId = randomId(); // Generated once, outside a retryable transaction.
    return db.runTransaction(async (t) => {
      const fresh = await readConfig(t);
      if (!fresh.enabled || fresh.mode !== cfg.mode || fresh.pilot !== cfg.pilot
        || fresh.merchantId !== cfg.merchantId || fresh.orderPrefix !== cfg.orderPrefix) {
        fail("failed-precondition", "La configuración de pagos cambió. Recargá el checkout.");
      }
      let pilot;
      if (cfg.pilot) {
        pilot = (await t.get(pilotRef())).data();
        if (!pilotPermits(pilot, request) || !pilot.ownerUid || (pilot.orderId && pilot.orderId !== ctx.id)
          || (fresh.seed && (fresh.seed.stage !== "open" || fresh.seed.tokenHash !== pilot.tokenHash)))
          fail("permission-denied", "Esta prueba admite un único pedido de la sesión invitada.");
      }
      const snap = await t.get(ctx.ref);
      if (!snap.exists) fail("not-found", "Pedido no encontrado.");
      const order = snap.data();
      assertOwner(order, ctx.uid);
      if (order.tilopay) return { existing: true };
      if (isPaidOrder(order) || order.paymentStatus === "test_paid") return { settled: true };
      if (!PAYABLE_STATUSES.has(order.status) || order.paymentMethod !== "tilopay" || order.paypal) {
        fail("failed-precondition", "Este pedido no permite iniciar un pago Tilopay.");
      }
      const itemSnap = await t.get(itemsQuery(ctx.ref));
      const input = itemSnap.docs.map((doc) => ({ ...doc.data(), itemId: doc.id }));
      let snapshot;
      try { snapshot = await priceSnapshot(order, input, t); }
      catch (error) { fail("failed-precondition", error.message); }
      assertExpectedQuote(expectedQuote, snapshot);
      if (pilot) {
        const [line] = snapshot.lines;
        if (snapshot.lines.length !== 1 || line.productId !== pilot.productId || line.variantId !== pilot.variantId
          || line.quantity !== 1 || snapshot.currency !== "CRC" || snapshot.totalMinor !== 100000
          || snapshot.amountMinor !== 100000) fail("failed-precondition", "La prueba requiere únicamente una unidad del artículo de ₡1 000.");
      }
      const lockId = checkoutLockId(snapshot, cfg.mode);
      const lockRef = db.collection("tilopayCheckoutLocks").doc(lockId);
      const lockSnap = await t.get(lockRef);
      const lock = lockSnap.exists ? lockSnap.data() : null;
      if (lock && lock.orderId !== ctx.id && !SETTLED_LOCKS.has(lock.state)) {
        if (lock.ownerUid !== ctx.uid) fail("internal", "Referencia de compra inconsistente.");
        return { blockedOrderId: lock.orderId };
      }
      const number = api.tilopayReference(tokenId, 1);
      const reference = refDoc(number);
      if ((await t.get(reference)).exists) fail("aborted", "No se pudo reservar una referencia única.");

      // A test never reserves real inventory. Existing server reservations must match exactly.
      const stockLines = snapshot.lines.filter((line) => line.supplyType === "stock_propio")
        .map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity }));
      const inventoryWrites = [];
      let reservation = order.inventoryReservation;
      if (cfg.mode === "live") {
        if (reservation) {
          const canonical = (rows) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
          if (reservation.state !== "reserved" || !Array.isArray(reservation.lines)
            || snapshotFingerprint(canonical(reservation.lines)) !== snapshotFingerprint(canonical(stockLines))) {
            fail("failed-precondition", "La reserva de inventario requiere revisión.");
          }
        } else {
          for (const line of stockLines) {
            const ref = db.collection("products").doc(line.productId).collection("variants").doc(line.variantId);
            const variantSnap = await t.get(ref);
            if (!variantSnap.exists) fail("failed-precondition", "Variante no encontrada para reservar inventario.");
            let inventory;
            try { inventory = normalizeInventoryStock(variantSnap.data(), { context: "tilopay_reserve" }); }
            catch { fail("failed-precondition", "El stock del producto requiere revisión."); }
            if (inventory.stock - inventory.reservedStock < line.quantity) {
              fail("failed-precondition", "Stock insuficiente para este pedido.");
            }
            inventoryWrites.push({ ref, reservedStock: inventory.reservedStock + line.quantity });
          }
          reservation = { version: 1, state: "reserved", lines: stockLines, createdAt: now() };
        }
      }
      const createdAt = now();
      const quote = quoteFromSnapshot(snapshot);
      const items = paymentItems(snapshot);
      const attempt = {
        schemaVersion: 2, key: "a1", n: 1, orderNumber: number,
        amount: minorToCRC(snapshot.amountMinor), amountMinor: snapshot.amountMinor, currency: "CRC",
        mode: cfg.mode, merchantId: cfg.merchantId, orderPrefix: cfg.orderPrefix,
        keyFingerprint: snapshotFingerprint({ key: c.key }), snapshot, orderVersion: snapshotFingerprint(snapshot),
        status: "reserved", createdAt, createdBy: ctx.uid, requestSentAt: createdAt,
      };
      // No network operations inside this transaction. All reads precede these writes.
      for (const write of inventoryWrites) t.update(write.ref, { reservedStock: write.reservedStock });
      if (pilot) t.update(pilotRef(), { orderId: ctx.id, reservedAt: createdAt });
      for (const item of items) t.set(ctx.ref.collection("items").doc(item.itemId), item);
      t.set(reference, { version: 1, orderId: ctx.id, attemptKey: "a1", ownerUid: ctx.uid,
        orderNumber: number, mode: cfg.mode, merchantId: cfg.merchantId, createdAt });
      t.set(lockRef, { orderId: ctx.id, attemptKey: "a1", ownerUid: ctx.uid, mode: cfg.mode,
        state: "active", createdAt, updatedAt: createdAt });
      const update = {
        ...paymentPlanFields(snapshot), itemsSummary: items,
        itemCount: snapshot.lines.reduce((sum, line) => sum + line.quantity, 0), updatedAt: createdAt,
        priceCorrectedByServer: { previousTotal: order.total ?? null, at: createdAt },
        tilopay: { schemaVersion: 2, mode: cfg.mode, attemptCount: 1, currentAttempt: "a1", checkoutLockId: lockId,
          ...quote, status: "reserved", attemptsById: { a1: attempt } },
      };
      if (cfg.mode === "live") {
        update.inventoryReservation = reservation;
        // Creation and its reconciliation queue entry commit together. The
        // customer may close the bank page without ever returning to checkout.
        t.set(db.collection("tilopayReconciliation").doc(ctx.id), {
          orderId: ctx.id, nextCheckAt: createdAt, createdAt, updatedAt: createdAt,
        });
      }
      t.update(ctx.ref, update);
      return { attempt, order: { ...order, ...update } };
    });
  }

  async function recordCreation(ctx, attempt, response, outcome) {
    return db.runTransaction(async (t) => {
      const snap = await t.get(ctx.ref);
      if (!snap.exists) return { result: "review", retry: false, orderId: ctx.id, message: "Conserva el número de pedido y solicita revisión." };
      const order = snap.data();
      assertOwner(order, ctx.uid);
      const itemSnap = await t.get(itemsQuery(ctx.ref));
      const current = order.tilopay?.attemptsById?.[attempt.key];
      if (!current || current.orderNumber !== attempt.orderNumber || (current.formGeneration || 0) !== (attempt.formGeneration || 0)) {
        fail("failed-precondition", "La referencia del pago cambió y requiere revisión.");
      }
      const success = outcome.reason === "FORM_READY";
      const tpd = { ...order.tilopay, attemptsById: { ...order.tilopay.attemptsById } };
      const safeToReturn = success && ["reserved", "open"].includes(current.status)
        && !isPaidOrder(order) && order.paymentStatus !== "test_paid"
        && PAYABLE_STATUSES.has(order.status) && snapshotMatches(order, itemSnap.docs, current);
      const patch = { creationCheckedAt: now(), formInFlight: false, creationOutcome: success && !safeToReturn
        ? { ...outcome, reason: "ORDER_CHANGED" } : outcome };
      if (success) patch.url = response.data.url;
      if (!FINAL_ATTEMPT_STATES.has(current.status)) {
        patch.status = safeToReturn ? "open" : "pending_reconciliation";
        if (!safeToReturn) patch.reason = "No se confirmó una página de pago utilizable para este pedido. Reconciliar el mismo intento.";
      }
      tpd.attemptsById[attempt.key] = { ...current, ...patch };
      const update = { tilopay: tpd, updatedAt: now() };
      if (!safeToReturn && !isPaidOrder(order) && order.paymentStatus !== "test_paid") {
        tpd.status = "pending_reconciliation";
        if (current.mode === "live" && PAYABLE_STATUSES.has(order.status)) {
          update.paymentStatus = "verificando"; update.status = "revision_manual";
        }
      }
      t.update(ctx.ref, update);
      if (safeToReturn) return { orderId: ctx.id, orderNumber: order.orderNumber,
        url: response.data.url, ...quoteFromSnapshot(current.snapshot),
        partial: validateSnapshotAmounts(current.snapshot).remainingMinor > 0, reused: false };
      return summarize({ ...order, ...update }, ctx.id);
    });
  }

  async function readObservations(ctx, cfg, c, token, { deadline, liveOnly = false } = {}) {
    const fresh = (await ctx.ref.get()).data();
    assertOwner(fresh, ctx.uid);
    if (liveOnly && !onlyLiveAttempts(fresh)) return null;
    let targets = attemptsOf(fresh);
    // Legacy references stay visible and block new charges; missing snapshots are never invented.
    if (!targets.length && Array.isArray(fresh.tilopay?.orderNumbers)) {
      targets = fresh.tilopay.orderNumbers.map((number, i) => ({ key: `legacy${i}`, orderNumber: number,
        amount: fresh.tilopay.crcTotal, mode: fresh.tilopay.mode, schemaVersion: 0 }));
    }
    if (!targets.length) return [{ key: "legacy", r: { state: "legacy_review", reason: "Intento antiguo sin datos suficientes." } }];
    if (targets.length > 100) fail("resource-exhausted", "Demasiados intentos: requiere conciliación administrativa.");
    return mapLimited(targets, async (attempt) => {
      const legacy = attempt.schemaVersion !== 2;
      const contextHash = attemptContext(attempt);
      if (deadline !== undefined && clock() + 25000 > deadline) {
        return { key: attempt.key, original: attempt.orderNumber, contextHash,
          r: { state: "pending_reconciliation", transient: true,
            reason: "La consulta continuará en la próxima conciliación programada." } };
      }
      if (typeof attempt.orderNumber !== "string" || !attempt.orderNumber
        || (!legacy && attempt.keyFingerprint !== snapshotFingerprint({ key: c.key }))) {
        return { key: attempt.key, original: attempt.orderNumber, contextHash, r: { state: "pending_reconciliation", reason: "Contexto de la integración cambió o falta la referencia." } };
      }
      const merchantId = attempt.merchantId || (legacy ? cfg.merchantId : "");
      let response;
      try {
        response = await api.tpFetch("/api/v1/consult", { token,
          body: { key: c.key, orderNumber: attempt.orderNumber,
            ...(attempt.mode === "live" ? { merchantId } : {}) } });
      } catch {
        return { key: attempt.key, original: attempt.orderNumber, contextHash,
          r: { state: "pending_reconciliation", transient: true,
            reason: "Consulta interrumpida; se reintentará sin alterar la evidencia de pago guardada." } };
      }
      let r;
      if (!response?.ok || response.jsonValid === false) {
        // A failed transport/parse provides no new financial evidence. However,
        // a readable error response containing movements may contain a refund
        // or contradiction and must remain subject to the conservative review.
        const hasMovements = response?.jsonValid !== false
          && Array.isArray(response?.data?.response) && response.data.response.length > 0;
        r = { state: "pending_reconciliation", transient: !hasMovements,
          reason: hasMovements ? "La consulta falló y contiene movimientos que requieren revisión."
            : "Tilopay no devolvió una consulta válida. Se volverá a consultar." };
      } else {
        try {
          r = api.interpretConsult(response.data, { orderNumber: attempt.orderNumber,
            amountMinor: attempt.amountMinor, amount: attempt.amount, mode: attempt.mode,
            merchantId, orderPrefix: attempt.orderPrefix || "" });
        } catch {
          // Validation errors are not labelled as transient transport failures.
          r = { state: "pending_reconciliation", reason: "No se pudo validar el contenido de consult." };
        }
      }
      if (legacy) r = { ...r, state: "legacy_review", transient: false,
        reason: "Intento anterior sin snapshot verificable; revisar el movimiento antes de acreditar." };
      return { key: attempt.key, original: attempt.orderNumber, contextHash, r };
    });
  }

  async function applyObservations(ctx, observations, { liveOnly = false } = {}) {
    return db.runTransaction(async (t) => {
      const snap = await t.get(ctx.ref);
      if (!snap.exists) fail("not-found", "Pedido no encontrado.");
      const order = snap.data();
      assertOwner(order, ctx.uid);
      if (liveOnly && !onlyLiveAttempts(order)) return { result: "skipped", orderId: ctx.id, reason: "not_live" };
      const itemSnap = await t.get(itemsQuery(ctx.ref));
      const tpd = { ...order.tilopay, attemptsById: { ...(order.tilopay?.attemptsById || {}) } };
      const paidAlready = isPaidOrder(order);
      const update = { updatedAt: now() };
      const ledgerReads = new Map();
      const referenceReads = new Map();
      const financial = observations.filter(({ r }) => ["approved", "pending_capture"].includes(r.state));
      for (const observation of financial) {
        const attempt = tpd.attemptsById[observation.key];
        if (!attempt) continue;
        const tx = observation.r.tx;
        const ledgerId = snapshotFingerprint({
          // Test has no required merchant identity: scope its registry to the
          // server's integration fingerprint, never to an unverified response.
          merchantId: attempt.mode === "test" ? `test-key:${attempt.keyFingerprint}` : attempt.merchantId,
          mode: attempt.mode, id: String(tx.id_tilopay) });
        observation.ledgerId = ledgerId;
        if (!ledgerReads.has(ledgerId)) {
          const ref = db.collection("tilopayTx").doc(ledgerId);
          const doc = await t.get(ref);
          ledgerReads.set(ledgerId, { ref, data: doc.exists ? doc.data() : null });
        }
        const reference = refDoc(attempt.orderNumber);
        const doc = await t.get(reference);
        referenceReads.set(observation.key, doc.exists ? doc.data() : null);
      }
      const lockRef = tpd.checkoutLockId ? db.collection("tilopayCheckoutLocks").doc(tpd.checkoutLockId) : null;
      const lockSnap = lockRef ? await t.get(lockRef) : null;
      const ledgerWrites = new Map();
      const approved = [];
      // Integrity/duplicate/legacy alerts require explicit administrative resolution.
      // A later clean response must not silently clear an earlier contradictory movement.
      if (Object.values(tpd.attemptsById).some((a) => a.reconciliationNeedsReview)) tpd.reconciliationNeedsReview = true;
      let needsReview = Boolean(tpd.reconciliationNeedsReview || tpd.duplicatePaymentNeedsReview || tpd.legacyNeedsReview);
      let transientConsult = false;
      for (const observation of observations) {
        const { key, r } = observation;
        const attempt = tpd.attemptsById[key];
        if (!attempt || r.state === "legacy_review" || attempt.schemaVersion !== 2) {
          tpd.legacyNeedsReview = true; needsReview = true;
          tpd.legacyLastCheckedAt = now();
          continue;
        }
        const a = { ...attempt, lastCheckedAt: now(), lastObservedState: r.state, providerOrderAbsent: r.explicitMissing === true,
          lastObservationTransient: r.transient === true };
        tpd.attemptsById[key] = a;
        if (attempt.orderNumber !== observation.original || attemptContext(attempt) !== observation.contextHash) {
          if (!FINAL_ATTEMPT_STATES.has(a.status)) a.status = "pending_reconciliation";
          a.reconciliationNeedsReview = true; a.reason = "El contexto del intento cambió mientras se consultaba.";
          tpd.reconciliationNeedsReview = true; needsReview = true; continue;
        }
        if (r.state === "pending_reconciliation" && r.transient === true) {
          transientConsult = true;
          a.lastObservationReason = r.reason || "La consulta se reintentará.";
          if (FINAL_ATTEMPT_STATES.has(attempt.status)) {
            // Preserve an already verified capture across a bank outage. Local
            // integrity is still checked, and any earlier alert remains sticky.
            if (!snapshotMatches(order, itemSnap.docs, attempt)) {
              a.reconciliationNeedsReview = true; tpd.reconciliationNeedsReview = true; needsReview = true;
              a.reason = "El contenido o los datos del pedido cambiaron después de cotizar el pago.";
            }
          } else {
            a.status = "pending_reconciliation";
            a.reason = a.lastObservationReason;
            needsReview = true;
          }
          continue;
        }
        // A rejection, absence or incomplete response cannot erase a verified capture.
        if (FINAL_ATTEMPT_STATES.has(attempt.status) && !["approved", "pending_capture"].includes(r.state)) {
          a.lastObservationReason = r.reason || "";
          if (r.state === "mismatch" || r.state === "pending_reconciliation") {
            a.reconciliationNeedsReview = true; tpd.reconciliationNeedsReview = true; needsReview = true;
          }
          continue;
        }
        if (!["approved", "pending_capture"].includes(r.state)) {
          if (r.state === "not_found") {
            // No transaction yet does not expire a hosted page or clear an unknown creation.
            if (!["reserved", "open"].includes(a.status)) needsReview = REVIEW_STATES.has(a.status) || needsReview;
          } else {
            a.status = r.state === "declined" ? "declined" : "pending_reconciliation";
            a.reason = r.reason || "Resultado pendiente de conciliación.";
            needsReview = a.status !== "declined" || needsReview;
          }
          continue;
        }
        const tx = r.tx;
        const ledger = ledgerReads.get(observation.ledgerId);
        const refData = referenceReads.get(key);
        const claim = ledgerWrites.get(observation.ledgerId) || ledger.data;
        if (r.env !== attempt.mode || r.amountMinor !== attempt.amountMinor
          || (attempt.mode === "live" && String(tx.merchantId) !== attempt.merchantId)) {
          if (!FINAL_ATTEMPT_STATES.has(a.status)) a.status = "mismatch";
          a.reason = "La evidencia no coincide con el contexto inmutable del intento.";
          a.reconciliationNeedsReview = true; tpd.reconciliationNeedsReview = true; needsReview = true; continue;
        }
        if (FINAL_ATTEMPT_STATES.has(attempt.status)) {
          if (String(tx.id_tilopay) !== String(attempt.idTilopay)) {
            a.lastObservedTransactionId = String(tx.id_tilopay);
            a.reconciliationNeedsReview = true;
            tpd.duplicatePaymentNeedsReview = true; needsReview = true;
            if (!claim || (claim.orderId === ctx.id && claim.attemptKey === key)) {
              ledgerWrites.set(observation.ledgerId, { version: 2, orderId: ctx.id, attemptKey: key,
                ownerUid: ctx.uid, merchantId: attempt.merchantId, mode: attempt.mode,
                idTilopay: String(tx.id_tilopay), orderNumber: attempt.orderNumber, amountMinor: r.amountMinor,
                state: "needs_review", createdAt: claim?.createdAt || now(), updatedAt: now() });
            }
            continue;
          }
          if (r.state === "pending_capture") continue; // Older authorization cannot replace captured evidence.
        }
        let reason = "";
        if (!refData || refData.orderId !== ctx.id || refData.attemptKey !== key || refData.ownerUid !== ctx.uid) {
          reason = "La referencia no está reservada para este pedido.";
        } else if (claim && (claim.orderId !== ctx.id || claim.attemptKey !== key)) {
          reason = "La transacción está vinculada a otro pedido o intento.";
        } else if (!snapshotMatches(order, itemSnap.docs, a)) {
          reason = "El contenido o los datos del pedido cambiaron después de cotizar el pago.";
        } else if (!PAYABLE_STATUSES.has(order.status) && !paidAlready && order.paymentStatus !== "test_paid") {
          reason = "Llegó un pago a un pedido cancelado o no habilitado para entrega.";
        }
        a.idTilopay = String(tx.id_tilopay); a.returnedOrderNumber = tx.orderNumber;
        a.environment = tx.environment; a.capture = tx.capture;
        a.observedMerchantId = typeof tx.merchantId === "string" ? tx.merchantId : "";
        a.validatedAmount = minorToCRC(r.amountMinor); a.validatedAmountMinor = r.amountMinor;
        a.financialEvidence = r.state === "approved" ? "captured" : "authorized";
        if (!claim || (claim.orderId === ctx.id && claim.attemptKey === key)) {
          ledgerWrites.set(observation.ledgerId, { version: 2, orderId: ctx.id, attemptKey: key,
            ownerUid: ctx.uid, merchantId: a.merchantId, mode: a.mode, idTilopay: a.idTilopay,
            orderNumber: a.orderNumber, amountMinor: r.amountMinor,
            state: reason ? "needs_review" : r.state, createdAt: claim?.createdAt || now(), updatedAt: now() });
        }
        if (reason) {
          if (!FINAL_ATTEMPT_STATES.has(attempt.status)) a.status = "mismatch";
          a.reason = reason; a.reconciliationNeedsReview = true; needsReview = true;
          tpd.reconciliationNeedsReview = true;
          continue;
        }
        if (r.state === "pending_capture") {
          if (!FINAL_ATTEMPT_STATES.has(attempt.status)) { a.status = "pending_capture"; a.reason = r.reason; needsReview = true; }
          continue;
        }
        // Never replace the transaction identity of a previously credited attempt.
        if (attempt.idTilopay && FINAL_ATTEMPT_STATES.has(attempt.status) && String(attempt.idTilopay) !== a.idTilopay) {
          a.status = "mismatch"; a.reason = "Apareció otra transacción para un intento acreditado.";
          tpd.duplicatePaymentNeedsReview = true; needsReview = true; continue;
        }
        a.status = a.mode === "test" ? "test_paid" : "approved";
        a.confirmedAt = attempt.confirmedAt || now();
        approved.push({ key, attempt: a, tx, ledgerId: observation.ledgerId });
      }
      const candidates = approved.filter(({ attempt }) => attempt.mode === "live");
      const allCaptures = attemptsOf({ tilopay: tpd }).filter((a) => a.mode === "live" && a.financialEvidence === "captured");
      const distinct = new Set(allCaptures.map((a) => `${a.merchantId}:${a.idTilopay}`));
      if (distinct.size > 1 || (paidAlready && candidates.some(({ attempt }) =>
        order.paymentMethod !== "tilopay" || String(order.paymentTransactionId) !== attempt.idTilopay))) {
        tpd.duplicatePaymentNeedsReview = true; needsReview = true;
      }
      let justPaid = false;
      let paidItems = [];
      if (!paidAlready && order.paymentStatus !== "test_paid" && !needsReview && !transientConsult && candidates.length === 1) {
        const { key, attempt, tx } = candidates[0];
        const amounts = validateSnapshotAmounts(attempt.snapshot);
        const partial = amounts.remainingMinor > 0;
        paidItems = paymentItems(attempt.snapshot, true);
        Object.assign(update, { ...paymentPlanFields(attempt.snapshot, true), itemsSummary: paidItems,
          // applyPaidOrder moves a fully paid order directly to por_preparar.
          // Do not expose an intermediate status pagado to legacy stock triggers.
          paymentMethod: "tilopay", paymentStatus: partial ? "parcial" : "pagado", status: "pendiente_pago",
          paymentAmount: attempt.validatedAmount, paymentTransactionId: attempt.idTilopay, paymentDate: now(),
          reconciliationResult: "tilopay_consult", reconciliationDetails: { method: "tilopay",
            orderNumber: attempt.orderNumber, merchantId: attempt.merchantId, environment: tx.environment,
            paidCRC: minorToCRC(amounts.amountMinor), balanceDueCRC: minorToCRC(amounts.remainingMinor) } });
        Object.assign(tpd, { status: "approved", paidAttemptKey: key, tilopayId: attempt.idTilopay,
          orderNumber: attempt.orderNumber, confirmedAt: now(), reconciliationNeedsReview: false });
        justPaid = true;
      } else if (!paidAlready && !needsReview && !transientConsult && approved.length === 1 && approved[0].attempt.mode === "test") {
        update.paymentStatus = "test_paid"; tpd.status = "test_paid";
      } else if (!paidAlready && order.paymentStatus !== "test_paid" && needsReview) {
        tpd.status = "pending_reconciliation";
        if (attemptsOf({ tilopay: tpd }).some((a) => a.mode === "live") && PAYABLE_STATUSES.has(order.status)) {
          update.paymentStatus = "verificando"; update.status = "revision_manual";
        }
      }
      for (const [id, value] of ledgerWrites) t.set(ledgerReads.get(id).ref, value);
      for (const item of paidItems) t.set(ctx.ref.collection("items").doc(item.itemId), item);
      if (lockRef && lockSnap?.exists && lockSnap.data().orderId === ctx.id) {
        const state = tpd.duplicatePaymentNeedsReview || needsReview ? "review"
          : (paidAlready || justPaid) ? "paid" : update.paymentStatus === "test_paid" ? "test_paid" : "active";
        t.update(lockRef, { state, updatedAt: now() });
      }
      update.tilopay = tpd;
      t.update(ctx.ref, update);
      const result = summarize({ ...order, ...update }, ctx.id, justPaid);
      if (transientConsult && !tpd.reconciliationNeedsReview && !tpd.duplicatePaymentNeedsReview && !tpd.legacyNeedsReview) {
        return { ...result, result: "review", code: "pending_reconciliation", transient: true,
          message: paidAlready ? "El pago recibido sigue acreditado. Tilopay no respondió a la consulta más reciente; volveremos a verificarlo. No vuelvas a pagar."
            : "No pudimos consultar Tilopay en este momento. Volveremos a verificar este mismo pedido; no inicies otro cobro." };
      }
      return result;
    });
  }

  async function verifyAndApply(ctx, options) {
    const cfg = await readConfig();
    const c = configuredCredentials();
    const token = await tokenFor(c);
    const observations = await readObservations(ctx, cfg, c, token, options);
    if (!observations) return { result: "skipped", orderId: ctx.id, reason: "not_live" };
    return applyObservations(ctx, observations, options);
  }

  async function confirm(request) {
    const ctx = await owned(request);
    if (!ctx.order.tilopay) fail("failed-precondition", "Este pedido no tiene un intento Tilopay.");
    const attempts = attemptsOf(ctx.order);
    if (attempts.some((a) => a.mode === "test") || ctx.order.tilopay.mode === "test") await requireTester(ctx.uid);
    return verifyAndApply(ctx);
  }

  // Trusted server entry point, never exposed as a callable and never given a
  // fabricated Firebase auth object. It reconciles only immutable LIVE attempts.
  async function reconcile(id, options = {}) {
    if (!validDocumentId(id)) fail("invalid-argument", "orderId inválido.");
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) fail("invalid-argument", "Plazo de conciliación inválido.");
    const ref = orderRef(id);
    const snap = await ref.get();
    const order = snap.exists ? snap.data() : null;
    if (!onlyLiveAttempts(order)) {
      return { result: "skipped", orderId: id, reason: "not_live" };
    }
    let uid;
    try { uid = orderOwnerUid(order); } catch { fail("failed-precondition", "Propietario del pedido inconsistente."); }
    return verifyAndApply({ ref, id, order, uid }, { ...options, liveOnly: true });
  }

  async function resume(request, cfg) {
    const result = await confirm(request);
    if (!["pending"].includes(result.result)) return result;
    const ctx = await owned(request);
    return db.runTransaction(async (t) => {
      const snap = await t.get(ctx.ref);
      if (!snap.exists) fail("not-found", "Pedido no encontrado.");
      const order = snap.data();
      assertOwner(order, ctx.uid);
      const latest = summarize(order, ctx.id);
      if (latest.result !== "pending") return latest;
      const atts = attemptsOf(order);
      if (atts.length !== 1) return { ...latest, result: "review", message: "Hay intentos anteriores que deben revisarse antes de otro cobro." };
      const a = atts[0];
      const docs = (await t.get(itemsQuery(ctx.ref))).docs;
      if (a.schemaVersion === 2 && a.mode === cfg.mode && a.status === "open" && api.isValidPaymentUrl(a.url)
        && PAYABLE_STATUSES.has(order.status) && snapshotMatches(order, docs, a)) {
        return { orderId: ctx.id, orderNumber: order.orderNumber, url: a.url,
          ...quoteFromSnapshot(a.snapshot), partial: validateSnapshotAmounts(a.snapshot).remainingMinor > 0, reused: true };
      }
      return latest;
    });
  }

  async function create(request) {
    const ctx = await owned(request);
    const cfg = await readConfig();
    if (!cfg.enabled) fail("failed-precondition", "Tilopay está deshabilitado o falta configurar el comercio.");
    if (cfg.pilot) {
      const pilot = (await pilotRef().get()).data();
      if (!pilotPermits(pilot, request) || !pilot.ownerUid || (pilot.orderId && pilot.orderId !== ctx.id)
        || (cfg.seed && (cfg.seed.stage !== "open" || cfg.seed.tokenHash !== pilot.tokenHash))
        || (ctx.order.tilopay && (pilot.orderId !== ctx.id || ctx.order.tilopay.mode !== "live"))) {
        fail("permission-denied", "Este pago está limitado al pedido de la sesión invitada.");
      }
    }
    if (cfg.mode === "test") await requireTester(ctx.uid);
    if (request.data?.retryMissingTestFormGeneration !== undefined) {
      return requestMissingTestForm(ctx, cfg, request.data.retryMissingTestFormGeneration);
    }
    if (ctx.order.tilopay) return resume(request, cfg);
    if (isPaidOrder(ctx.order)) return summarize(ctx.order, ctx.id);
    if (request.data?.expectedQuote !== undefined) {
      // Fail stale/tampered displayed totals before even asking for a token.
      const docs = (await itemsQuery(ctx.ref).get()).docs;
      let snapshot;
      try { snapshot = await priceSnapshot(ctx.order, docs.map((doc) => ({ ...doc.data(), itemId: doc.id }))); }
      catch (error) { fail("failed-precondition", error.message); }
      assertExpectedQuote(request.data.expectedQuote, snapshot);
    }
    const c = configuredCredentials();
    const token = await tokenFor(c);
    const reservation = await reserve(ctx, cfg, c, request.data?.expectedQuote, request);
    if (reservation.blockedOrderId) return { result: "pending", retry: false, orderId: reservation.blockedOrderId,
      message: "Ya hay un pago pendiente para estos productos. Verifica el pedido original." };
    if (reservation.existing) return resume(request, cfg);
    if (reservation.settled) return summarize((await ctx.ref.get()).data(), ctx.id);
    return issueForm(ctx, c, token, reservation);
  }

  // An explicit operator action for sandbox only. Preserve the original
  // reference and amount and serialize a new form request on the same order.
  async function requestMissingTestForm(ctx, cfg, generation) {
    if (cfg.mode !== "test" || ctx.order.tilopay?.mode !== "test") fail("failed-precondition", "Solo disponible en pruebas.");
    if (!Number.isSafeInteger(generation) || generation < 0) fail("invalid-argument", "Solicitud de formulario inválida.");
    const observed = await verifyAndApply(ctx);
    if (observed.testFormGeneration !== generation) return observed;
    const c = configuredCredentials();
    const token = await tokenFor(c);
    const claim = await db.runTransaction(async (t) => {
      const order = (await t.get(ctx.ref)).data();
      assertOwner(order, ctx.uid);
      const result = summarize(order, ctx.id);
      if (result.testFormGeneration !== generation) return { result };
      const a = attemptsOf(order)[0];
      const settings = (await t.get(db.collection("config").doc("payments"))).data()?.tilopay;
      const items = await t.get(itemsQuery(ctx.ref));
      const lock = (await t.get(db.collection("tilopayCheckoutLocks").doc(order.tilopay.checkoutLockId))).data();
      const ref = (await t.get(refDoc(a.orderNumber))).data();
      if (settings?.enabled !== true || settings.mode !== "test" || settings.merchantId !== a.merchantId
        || settings.orderPrefix !== a.orderPrefix || a.keyFingerprint !== snapshotFingerprint({ key: c.key })
        || lock?.orderId !== ctx.id || lock.ownerUid !== ctx.uid || lock.mode !== "test" || lock.attemptKey !== a.key || SETTLED_LOCKS.has(lock.state)
        || ref?.orderId !== ctx.id || ref.ownerUid !== ctx.uid || ref.mode !== "test" || ref.attemptKey !== a.key || ref.orderNumber !== a.orderNumber
        || !snapshotMatches(order, items.docs, a)) fail("failed-precondition", "El contexto del pedido cambió. Requiere revisión.");
      const attempt = { ...a, formGeneration: generation + 1, formInFlight: true, providerOrderAbsent: false,
        formRequestedAgainAt: now(), status: "reserved" };
      t.update(ctx.ref, { tilopay: { ...order.tilopay, status: "reserved",
        attemptsById: { ...order.tilopay.attemptsById, [a.key]: attempt } }, updatedAt: now() });
      return { order, attempt };
    });
    return claim.result || issueForm(ctx, c, token, claim);
  }

  async function issueForm(ctx, c, token, { attempt, order }) {
    let response; let error; let sent = false;
    try {
      const base = String(returnBase()).replace(/\/+$/, "");
      const url = new URL(base);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("URL de retorno inválida.");
      const payload = api.buildProcessPayload({ key: c.key,
        redirect: `${base}/tilopay/retorno/${encodeURIComponent(ctx.id)}`, orderId: ctx.id,
        order, orderNumber: attempt.orderNumber, amountMinor: attempt.amountMinor });
      sent = true;
      response = await api.tpFetch("/api/v1/processPayment", { token, body: payload });
    } catch (e) { error = e; }
    const outcome = defaultApi.processPaymentOutcome(response, error, sent);
    console.info(JSON.stringify({ event: "tilopay_process_payment", orderId: ctx.id, mode: attempt.mode, ...outcome }));
    return recordCreation(ctx, attempt, response, outcome);
  }

  async function getQuote(request) {
    if (!request?.auth?.uid) fail("unauthenticated", "Debes iniciar sesión.");
    const { items, canton, shippingType = "normal" } = request.data || {};
    try {
      if (!["normal", "express"].includes(shippingType)) {
        throw new PricingError("INVALID_SHIPPING_TYPE", "Tipo de envío inválido.");
      }
      if (canton !== undefined && (typeof canton !== "string" || canton.length > 100)) {
        throw new PricingError("INVALID_CANTON", "Cantón inválido.");
      }
      if (!Array.isArray(items)) throw new PricingError("INVALID_ITEM_COUNT", "Carrito inválido.");
      const snapshot = await priceSnapshot({ uid: request.auth.uid, shippingType, shippingAddress: { canton } },
        items.map((item, index) => ({ ...item, itemId: `item_${index}` })));
      return quoteFromSnapshot(snapshot);
    } catch (error) {
      const known = error instanceof PricingError;
      const reason = known ? error.reason : "QUOTE_INTERNAL_ERROR";
      const details = { reason, ...(known && Number.isInteger(error.lineIndex) ? { lineIndex: error.lineIndex } : {}) };
      // Only diagnostic codes and line positions: no credentials, auth tokens,
      // customer/contact fields, arbitrary messages or request/catalog dumps.
      try { onQuoteError({ severity: known ? "WARNING" : "ERROR", event: "tilopay_quote_rejected",
        ...details, itemCount: Array.isArray(items) ? items.length : 0 }); } catch { /* best effort telemetry */ }
      fail(known ? "invalid-argument" : "internal", known ? error.message : "No pudimos calcular el importe. Intentá nuevamente.", details);
    }
  }

  return {
    getConfig: async (request) => {
      const cfg = await readConfig();
      if (!cfg.enabled || !cfg.pilot) return { enabled: cfg.enabled, mode: cfg.mode };
      const enabled = await db.runTransaction(async t => {
        const current = await readConfig(t);
        if (!current.enabled || !current.pilot) return false;
        const ref = pilotRef();
        const saved = (await t.get(ref)).data();
        const seed = current.seed;
        const started = seed?.startedAt?.seconds;
        const canStart = seed?.stage === "open" && /^[a-f0-9]{64}$/.test(seed.tokenHash)
          && Number.isSafeInteger(started) && started * 1000 <= clock();
        const pilot = saved || (canStart ? { active: true, tokenHash: seed.tokenHash, productId: "zz-tilopay-live-check",
          variantId: "v1", expiresAt: started * 1000 + 2 * 3600000, phase: "open" } : null);
        if (seed && (!canStart || pilot?.tokenHash !== seed.tokenHash)) return false;
        if (!pilotPermits(pilot, request)) return false;
        if (!pilot.ownerUid) t.set(ref, { ...pilot, ownerUid: request.auth.uid,
          sessionHash: hash(request.data.pilotSession), claimedAt: now() });
        return true;
      });
      return { enabled, mode: cfg.mode };
    },
    getQuote, create, confirm, reconcile,
  };
}

module.exports = { createTilopayService };
