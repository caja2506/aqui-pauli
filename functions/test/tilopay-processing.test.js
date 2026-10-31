"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const tp = require("../lib/tilopayApi");
const { createTilopayService } = require("../lib/tilopayService");
const { makeSnapshot, snapshotFingerprint } = require("../lib/tilopayOrder");
const { applyPaidOrder } = require("../lib/orderFulfillment");
const { completeTilopayPayment, createTilopayReconciler } = require("../lib/tilopayReconciliation");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");

const ORDER_ID = "OrderLive12345678";
const ORDER = `orders/${ORDER_ID}`;
const QUEUE = "tilopayReconciliation";
const QUEUED_ORDER = `${QUEUE}/${ORDER_ID}`;
const VARIANT = "products/p1/variants/v1";
const BAG = "products/p2/variants/v2";
const START = Date.UTC(2026, 9, 31, 12);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const iso = (time) => new Date(time).toISOString();
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const request = () => ({ auth: { uid: "user1" }, data: { orderId: ORDER_ID } });
const response = (data) => ({ ok: true, status: 200, data, jsonValid: true });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

// Queue-only query adapter; the optimistic transaction double remains unchanged.
// All claims/completion/inventory/CRM writes use its real atomic/retry semantics.
function queueQueries(memory) {
  const collection = memory.db.collection.bind(memory.db);
  function queueQuery(filters = [], order = "nextCheckAt", limit = Infinity) {
    return { ...collection(QUEUE),
      where: (field, operator, value) => queueQuery([...filters, [field, operator, value]], order, limit),
      orderBy: (field) => queueQuery(filters, field, limit),
      limit: (value) => queueQuery(filters, order, value),
      get: async () => {
        const paths = Object.keys(memory.store).filter((key) => key.startsWith(`${QUEUE}/`) && key.split("/").length === 2)
          .filter((key) => filters.every(([field, operator, value]) => {
            assert.equal(operator, "<=");
            return typeof memory.store[key][field] === "string" && memory.store[key][field] <= value;
          }))
          .sort((a, b) => String(memory.store[a][order]).localeCompare(String(memory.store[b][order])) || a.localeCompare(b))
          .slice(0, limit);
        const docs = await Promise.all(paths.map((key) => memory.db.doc(key).get()));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }
  memory.db.collection = (name) => name === QUEUE ? queueQuery() : collection(name);
  return memory;
}

function loadEndpoints(db, service) {
  const config = {};
  const wrap = (options, handler) => {
    config[handler.name || `handler_${Object.keys(config).length}`] = options;
    handler.options = options;
    return handler;
  };
  const dependencies = {
    "firebase-functions/v2/https": { onCall: wrap, HttpsError },
    "firebase-functions/v2/scheduler": { onSchedule: wrap },
    "firebase-functions/params": { defineSecret: (name) => ({ name, value: () => "fixture-value" }),
      defineString: (_name, options) => ({ value: () => options.default }) },
    "./utils": { db }, "./crm": { CRM_DEFAULT_FIELDS: { source: "registro", totalOrders: 0, totalSpent: 0 } },
    "./lib/tilopayService": { createTilopayService: () => service },
    "./lib/tilopayReconciliation": { completeTilopayPayment, createTilopayReconciler },
  };
  const module = { exports: {} };
  const filename = path.resolve(__dirname, "../tilopay.js");
  new Function("require", "module", "exports", fs.readFileSync(filename, "utf8"))((name) => {
    assert.ok(dependencies[name], `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

function liveHarness({ kind = "stock", mode = "live" } = {}) {
  const seed = {
    "config/payments": { tilopay: { enabled: true, mode, merchantId: "88803956", orderPrefix: "PFC031932" } },
    "users_roles/user1": { role: "tester" },
    "products/p1": { active: true, name: "Perfume", basePrice: 45000, supplyType: "stock_propio" },
    [VARIANT]: { active: true, price: 45000, stock: 10, reservedStock: 0, supplyType: "stock_propio" },
    "products/p2": { active: true, name: "Bolso", basePrice: 60000, supplyType: "bajo_pedido" },
    [BAG]: { active: true, price: 60000, stock: 0, reservedStock: 0, supplyType: "bajo_pedido" },
    [ORDER]: { uid: "user1", customerUid: "user1", orderNumber: "AP-TEST", customerName: "Ana Test",
      customerEmail: "ana@example.invalid", customerPhone: "88887777", paymentMethod: "tilopay",
      paymentStatus: "pendiente", status: "pendiente_pago", total: 1, subtotal: 1, shippingCost: 0,
      shippingType: "normal", shippingAddress: { provincia: "Alajuela", canton: "Grecia", distrito: "San José", señas: "Casa" } },
  };
  if (kind !== "backorder") seed[`${ORDER}/items/item_0`] = { productId: "p1", variantId: "v1", quantity: 2, price: 1 };
  if (kind !== "stock") seed[`${ORDER}/items/item_1`] = { productId: "p2", variantId: "v2", quantity: 1, price: 1 };
  const memory = queueQueries(createMemoryFirestore(seed));
  const calls = { pay: 0, consult: 0, credentials: 0, statuses: [], reconcile: [], reconcileResults: [] };
  let now = START; let nonce = 0; let consultFailure = null;
  const bank = new Map();
  const service = createTilopayService({ db: memory.db, HttpsError, clock: () => now,
    randomId: () => String(++nonce).padStart(32, "0"), returnBase: () => "https://aquipauli.com",
    credentials: () => { calls.credentials++; return { apiUser: "fixture-user", password: "fixture-password", key: "fixture-key" }; },
    api: { ...tp, getToken: async () => "fixture-token", tpFetch: async (route, options) => {
      if (route.endsWith("processPayment")) {
        calls.pay++;
        return response({ type: "100", url: "https://secure.tilopay.com/htmls/test.html" });
      }
      assert.ok(route.endsWith("consult"), `Forbidden provider operation: ${route}`);
      calls.consult++;
      if (consultFailure === "timeout") throw new Error("fixture-consult-timeout");
      if (consultFailure === "http") return { ok: false, status: 503, data: {}, jsonValid: true };
      if (consultFailure === "json") return { ok: true, status: 200, data: null, jsonValid: false };
      return response({ type: "200", response: bank.get(options.body.orderNumber) || [] });
    } },
  });
  const reconciler = createTilopayReconciler({ db: memory.db, clock: () => now,
    reconcile: async (...args) => {
      calls.reconcile.push(args);
      const result = await service.reconcile(...args);
      calls.reconcileResults.push(result);
      return result;
    } });
  const endpoints = loadEndpoints(memory.db, service);
  const order = () => memory.get(ORDER);
  const attempt = () => order().tilopay.attemptsById.a1;
  const capture = (extra = {}) => {
    const a = attempt();
    bank.set(a.orderNumber, [{ orderNumber: `${a.orderPrefix}-${a.orderNumber}`, merchantId: a.merchantId,
      id_tilopay: "17", type: "Payment", code: "1", currency: "CRC", amount: tp.formatAmountCRC(a.amount),
      environment: mode === "test" ? "Test" : "Production", capture: "Capture", ...extra }]);
  };
  memory.db.beforeCommit = ({ writes }) => {
    for (const [, key, data] of writes) if (key === ORDER && data?.status) calls.statuses.push(data.status);
  };
  return { ...memory, calls, service, endpoints, reconciler, order, attempt, capture,
    setConsultFailure: (failure) => { consultFailure = failure; },
    clock: () => now, advance: (ms) => { now += ms; } };
}

for (const [kind, total, received, remaining, stock] of [
  ["stock", 90000, 90000, 0, 8], ["backorder", 60000, 30000, 30000, 10], ["mixed", 150000, 120000, 30000, 8],
]) test(`confirmación ${kind}: snapshot, inventario y CRM una vez; saldo preservado`, async () => {
  const h = liveHarness({ kind });
  await h.endpoints.tilopayCreatePayment(request());
  assert.equal(h.get(QUEUED_ORDER).orderId, ORDER_ID);
  h.capture();
  const first = await h.endpoints.tilopayConfirm(request());
  assert.equal(first.result, "paid");
  assert.equal(first.crcTotal, total);
  assert.equal(first.crcPayNow, received);
  assert.equal(first.crcBalanceDue, remaining);
  assert.equal(h.order().paymentStatus, remaining ? "parcial" : "pagado");
  assert.equal(h.order().status, remaining ? "pendiente_pago" : "por_preparar");
  assert.equal(h.order().remainingTotal, remaining);
  assert.equal(h.order().total, total);
  assert.equal(h.order().paymentAmount, received);
  assert.equal(h.order().fulfillment.state, "applied");
  assert.equal(h.order().fulfillment.version, 1);
  assert.equal(h.order().inventoryReservation.state, "consumed");
  assert.equal(h.get(VARIANT).stock, stock);
  assert.equal(h.get(VARIANT).reservedStock, 0);
  assert.equal(h.get(BAG).stock, 0);
  assert.equal(h.get("crm_contacts/user1").totalOrders, 1);
  assert.equal(h.get("crm_contacts/user1").totalSpent, received);
  assert.equal(h.get(`crm_contacts/user1/interactions/order_${ORDER_ID}_paid`).metadata.remainingTotal, remaining);
  if (remaining) assert.equal(h.get(`${ORDER}/items/item_1`).depositPaid, true);
  assert.equal((await h.endpoints.tilopayConfirm(request())).result, "already_paid");
  assert.equal((await h.endpoints.tilopayCreatePayment(request())).result, "already_paid");
  assert.equal(h.get(VARIANT).stock, stock);
  assert.equal(h.get("crm_contacts/user1").totalOrders, 1);
  assert.equal(h.calls.pay, 1);
  assert.equal(h.calls.statuses.includes("pagado"), false, "No dispara el trigger legado pagado");
});

test("cron rescata el navegador cerrado y compite con confirm sin duplicar stock/CRM", async () => {
  const h = liveHarness({ kind: "mixed" });
  await h.endpoints.tilopayCreatePayment(request());
  h.capture();
  const [scheduled, confirmed] = await Promise.all([h.reconciler.run(), h.endpoints.tilopayConfirm(request())]);
  assert.equal(scheduled.failed, 0);
  assert.equal(scheduled.queueErrors, 0);
  assert.ok(["paid", "already_paid"].includes(confirmed.result));
  assert.equal(h.order().paymentStatus, "parcial");
  assert.equal(h.order().status, "pendiente_pago");
  assert.equal(h.get(VARIANT).stock, 8);
  assert.equal(h.get(VARIANT).reservedStock, 0);
  assert.equal(h.get("crm_contacts/user1").totalOrders, 1);
  assert.equal(h.get("crm_contacts/user1").totalSpent, 120000);
  assert.equal(h.calls.pay, 1);
  assert.equal(h.calls.reconcile[0][0], ORDER_ID);
  assert.deepEqual(Object.keys(h.calls.reconcile[0][1]), ["deadline"]);
  assert.equal(h.get(QUEUED_ORDER).nextCheckAt, iso(START + DAY));
  assert.equal(h.get(QUEUED_ORDER).leaseId, "");
});

test("pago con navegador cerrado se acredita y prepara desde cron, sin llamada del cliente", async () => {
  const h = liveHarness();
  await h.endpoints.tilopayCreatePayment(request()); h.capture();
  const stats = await h.reconciler.run();
  assert.equal(stats.checked, 1);
  assert.equal(stats.failed, 0);
  assert.equal(h.order().status, "por_preparar");
  assert.equal(h.order().paymentStatus, "pagado");
  assert.equal(h.get(VARIANT).stock, 8);
  assert.equal(h.get("crm_contacts/user1").totalSpent, 90000);
  assert.equal(h.calls.pay, 1);
  assert.equal(h.calls.statuses.includes("pagado"), false);
});

test("fallo después de acreditar se repara por cron sin nuevo cobro ni estado pagado", async () => {
  const h = liveHarness();
  await h.endpoints.tilopayCreatePayment(request());
  h.capture();
  let failed = false;
  const prior = h.db.beforeCommit;
  h.db.beforeCommit = (change) => {
    prior(change);
    if (!failed && change.writes.some(([, key, data]) => key === VARIANT && data.stock === 8)) {
      failed = true; throw new Error("temporary-firestore-failure");
    }
  };
  await assert.rejects(h.endpoints.tilopayConfirm(request()), /temporary-firestore-failure/);
  assert.equal(h.order().paymentStatus, "pagado");
  assert.equal(h.order().status, "pendiente_pago");
  assert.equal(h.order().fulfillment, undefined);
  assert.equal(h.get(VARIANT).stock, 10);
  assert.equal(h.get("crm_contacts/user1"), undefined);
  const stats = await h.reconciler.run();
  assert.equal(stats.failed, 0);
  assert.equal(h.order().status, "por_preparar");
  assert.equal(h.get(VARIANT).stock, 8);
  assert.equal(h.get("crm_contacts/user1").totalOrders, 1);
  assert.equal(h.calls.pay, 1);
  assert.equal(h.calls.statuses.includes("pagado"), false);
});

function capturedEffects(h) {
  const order = h.order();
  const attempt = h.attempt();
  return { status: order.status, paymentStatus: order.paymentStatus, paymentAmount: order.paymentAmount,
    paymentDate: order.paymentDate, paymentTransactionId: order.paymentTransactionId,
    total: order.total, remainingTotal: order.remainingTotal, fulfillment: order.fulfillment,
    inventoryReservation: order.inventoryReservation,
    attemptStatus: attempt.status, financialEvidence: attempt.financialEvidence,
    validatedAmountMinor: attempt.validatedAmountMinor, idTilopay: attempt.idTilopay,
    stock: h.get(VARIANT), backorderStock: h.get(BAG), crm: h.get("crm_contacts/user1"),
    interaction: h.get(`crm_contacts/user1/interactions/order_${ORDER_ID}_paid`) };
}

for (const kind of ["stock", "mixed"]) for (const failure of ["timeout", "http", "json"]) {
  test(`consulta diaria ${kind}: ${failure} temporal mantiene captura y efectos; recuperación sin duplicarlos`, async () => {
    const h = liveHarness({ kind });
    await h.endpoints.tilopayCreatePayment(request()); h.capture();
    assert.equal((await h.reconciler.run()).checked, 1);
    const original = capturedEffects(h);
    assert.equal(original.fulfillment.state, "applied");
    assert.equal(h.get(QUEUED_ORDER).nextCheckAt, iso(START + DAY));

    h.advance(DAY); h.setConsultFailure(failure);
    for (const [errors, delay] of [[1, 5 * MINUTE], [2, 10 * MINUTE]]) {
      const run = await h.reconciler.run();
      assert.equal(run.checked, 1);
      assert.equal(run.failed, 0);
      const result = h.calls.reconcileResults.at(-1);
      assert.equal(result.result, "review");
      assert.equal(result.code, "pending_reconciliation");
      assert.equal(result.transient, true);
      assert.equal(result.paid, true);
      assert.equal(result.partial, kind === "mixed");
      assert.deepEqual(capturedEffects(h), original);
      assert.notEqual(h.order().tilopay.reconciliationNeedsReview, true);
      assert.notEqual(h.attempt().reconciliationNeedsReview, true);
      assert.notEqual(h.order().tilopay.duplicatePaymentNeedsReview, true);
      assert.equal(h.get(QUEUED_ORDER).consecutiveErrors, errors);
      assert.equal(h.get(QUEUED_ORDER).lastCode, "pending_reconciliation");
      assert.equal(h.get(QUEUED_ORDER).nextCheckAt, iso(h.clock() + delay));
      h.advance(delay);
    }

    h.setConsultFailure(null);
    assert.equal((await h.reconciler.run()).checked, 1);
    assert.equal(h.calls.reconcileResults.at(-1).result, "already_paid");
    assert.notEqual(h.calls.reconcileResults.at(-1).transient, true);
    assert.deepEqual(capturedEffects(h), original);
    assert.equal(h.get(QUEUED_ORDER).consecutiveErrors, 0);
    assert.equal(h.get(QUEUED_ORDER).nextCheckAt, iso(h.clock() + DAY));
    assert.notEqual(h.order().tilopay.reconciliationNeedsReview, true);
    assert.notEqual(h.attempt().reconciliationNeedsReview, true);
    assert.equal(h.calls.pay, 1);
  });
}

test("una recuperación de consult nunca borra una alerta real anterior ni reaplica inventario/CRM", async () => {
  const h = liveHarness({ kind: "mixed" });
  await h.endpoints.tilopayCreatePayment(request()); h.capture(); await h.reconciler.run();
  const flagged = h.order();
  flagged.status = "revision_manual";
  flagged.tilopay.reconciliationNeedsReview = true;
  flagged.tilopay.attemptsById.a1.reconciliationNeedsReview = true;
  flagged.tilopay.attemptsById.a1.reason = "Importe de un movimiento anterior inconsistente.";
  await h.set(ORDER, flagged);
  const original = capturedEffects(h);
  h.advance(DAY); h.setConsultFailure("timeout");
  await h.reconciler.run();
  assert.equal(h.calls.reconcileResults.at(-1).result, "review");
  assert.notEqual(h.calls.reconcileResults.at(-1).transient, true);
  assert.deepEqual(capturedEffects(h), original);
  h.advance(Date.parse(h.get(QUEUED_ORDER).nextCheckAt) - h.clock());
  h.setConsultFailure(null); await h.reconciler.run();
  assert.equal(h.calls.reconcileResults.at(-1).result, "review");
  assert.equal(h.order().tilopay.reconciliationNeedsReview, true);
  assert.equal(h.attempt().reconciliationNeedsReview, true);
  assert.equal(h.attempt().reason, "Importe de un movimiento anterior inconsistente.");
  assert.deepEqual(capturedEffects(h), original);
  assert.equal(h.calls.pay, 1);
});

test("cron sólo consulta: Authorize y monto incorrecto no aplican inventario o CRM", async () => {
  for (const extra of [{ capture: "Authorize" }, { amount: "1.00" }]) {
    const h = liveHarness(); await h.endpoints.tilopayCreatePayment(request()); h.capture(extra);
    const scheduled = await h.reconciler.run();
    assert.equal(scheduled.checked, 1);
    assert.notEqual(h.order().paymentStatus, "pagado");
    assert.equal(h.order().fulfillment, undefined);
    assert.equal(h.get(VARIANT).stock, 10);
    assert.equal(h.get("crm_contacts/user1"), undefined);
    assert.equal(h.calls.pay, 1);
    assert.ok(Date.parse(h.get(QUEUED_ORDER).nextCheckAt) > h.clock());
  }
});

test("test no se encola; una entrada residual test se retira sin leer credenciales", async () => {
  const h = liveHarness({ mode: "test" });
  await h.endpoints.tilopayCreatePayment(request());
  assert.equal(h.get(QUEUED_ORDER), undefined);
  h.capture();
  assert.equal((await h.endpoints.tilopayConfirm(request())).result, "test_paid");
  assert.equal(h.get(VARIANT).stock, 10);
  assert.equal(h.get("crm_contacts/user1"), undefined);
  await h.set(QUEUED_ORDER, { orderId: ORDER_ID, nextCheckAt: iso(START), createdAt: iso(START) });
  const before = h.calls.credentials;
  const consultations = h.calls.consult;
  const scheduled = await h.reconciler.run();
  assert.equal(scheduled.checked, 1);
  assert.equal(h.calls.credentials, before);
  assert.equal(h.calls.consult, consultations);
  assert.equal(h.get(QUEUED_ORDER), undefined);
});

test("históricos v1 completos se procesan sin reinterpretar el 50%", async () => {
  const h = liveHarness({ kind: "backorder" });
  const order = h.order();
  const snapshot = makeSnapshot(order, [{ itemId: "item_1", productId: "p2", variantId: "v2", quantity: 1,
    unitPrice: 60000, lineTotal: 60000, supplyType: "bajo_pedido" }],
  { subtotal: 60000, shippingCost: 0, total: 60000 }, { version: 1 });
  await h.set(ORDER, { ...order, status: "pagado", paymentStatus: "pagado", total: 60000, paymentAmount: 60000,
    // El calculador viejo de pedidos podía dejar un saldo aunque Tilopay cobró todo.
    remainingTotal: 30000, depositTotal: 30000,
    paymentTransactionId: "TX-OLD", tilopay: { mode: "live", paidAttemptKey: "a1", attemptsById: { a1: {
      schemaVersion: 2, mode: "live", status: "approved", financialEvidence: "captured", idTilopay: "TX-OLD",
      validatedAmountMinor: 6000000, snapshot, orderVersion: snapshotFingerprint(snapshot),
    } } } });
  assert.equal((await applyPaidOrder({ db: h.db, orderId: ORDER_ID })).kind, "applied");
  assert.equal(h.order().status, "por_preparar");
  assert.equal(h.order().remainingTotal, 0);
  assert.equal(h.order().depositTotal, 0);
  assert.equal(h.get("crm_contacts/user1").totalSpent, 60000);
});

test("snapshot parcial alterado, saldo incorrecto y cancelación no autorizan preparación", async () => {
  for (const mutation of [
    (order) => { order.tilopay.attemptsById.a1.snapshot.paymentPlan.depositMinor++; },
    (order) => { order.remainingTotal = 0; },
    (order) => { order.status = "cancelado"; },
  ]) {
    const h = liveHarness({ kind: "mixed" });
    await h.service.create(request()); h.capture();
    const result = await h.service.confirm(request());
    const order = h.order(); mutation(order); await h.set(ORDER, order);
    assert.equal((await completeTilopayPayment({ db: h.db, result })).result, "review");
    assert.equal(h.get(VARIANT).stock, 10);
    assert.equal(h.get("crm_contacts/user1"), undefined);
    assert.notEqual(h.order().status, "por_preparar");
  }
});

test("cotización exige sesión sin secretos ni rol; scheduler sólo usa secretos Tilopay", async () => {
  const h = liveHarness();
  const data = { items: [{ productId: "p1", variantId: "v1", quantity: 1 }],
    shippingType: "normal", canton: "Grecia" };
  await assert.rejects(h.endpoints.tilopayGetQuote({ data }), { code: "unauthenticated" });
  const quote = await h.endpoints.tilopayGetQuote({ auth: { uid: "guest", token: { firebase: { sign_in_provider: "anonymous" } } }, data });
  assert.equal(quote.crcPayNow, 45000);
  assert.equal(h.calls.credentials, 0);
  assert.equal(h.calls.pay, 0);
  assert.equal(h.endpoints.tilopayGetQuote.options.secrets, undefined);
  assert.deepEqual(h.endpoints.tilopayReconcilePayments.options.secrets.map((secret) => secret.name),
    ["TILOPAY_API_USER", "TILOPAY_API_PASSWORD", "TILOPAY_KEY"]);
  assert.equal(h.endpoints.tilopayReconcilePayments.options.schedule, "every 5 minutes");
  assert.equal(h.endpoints.tilopayReconcilePayments.options.maxInstances, 1);
});

function queueHarness(entries = 1, options = {}) {
  const seed = {};
  for (let i = 0; i < entries; i++) {
    const id = `Order${String(i).padStart(8, "0")}`;
    seed[`${QUEUE}/${id}`] = { orderId: id, nextCheckAt: iso(START), createdAt: iso(START) };
  }
  const h = queueQueries(createMemoryFirestore(seed));
  let now = START;
  const calls = [];
  const reconcile = async (orderId, config) => {
    calls.push({ orderId, config });
    return options.reconcile ? options.reconcile(orderId, config, h) : { result: "pending", orderId };
  };
  const create = () => createTilopayReconciler({ db: h.db, reconcile, clock: () => now });
  return { ...h, create, calls, clock: () => now, advance: (ms) => { now += ms; } };
}

test("cola acotada a 25: mover nextCheckAt evita que pendientes viejos bloqueen otros pedidos", async () => {
  const h = queueHarness(30); const worker = h.create();
  const first = await worker.run();
  assert.equal(first.scanned, 25);
  assert.equal(first.checked, 25);
  assert.equal(h.calls.length, 25);
  assert.equal(h.get(`${QUEUE}/Order00000000`).nextCheckAt, iso(START + 5 * MINUTE));
  const second = await worker.run();
  assert.equal(second.checked, 5);
  assert.equal(new Set(h.calls.map((call) => call.orderId)).size, 30);
  assert.equal((await worker.run()).checked, 0);
});

test("lease por entrada impide dos consultas de cron y recupera un proceso caído", async () => {
  const entered = deferred(); const release = deferred();
  const h = queueHarness(1, { reconcile: async (orderId) => { entered.resolve(); await release.promise; return { result: "pending", orderId }; } });
  const first = h.create().run(); await entered.promise;
  assert.equal((await h.create().run()).checked, 0);
  assert.equal(h.calls.length, 1);
  release.resolve(); await first;
  const ref = `${QUEUE}/Order00000000`;
  await h.set(ref, { ...h.get(ref), nextCheckAt: iso(START + 10 * MINUTE), leaseUntil: iso(START + 10 * MINUTE), leaseId: "crashed" });
  h.advance(10 * MINUTE);
  assert.equal((await h.create().run()).checked, 1);
  assert.equal(h.get(ref).leaseId, "");
});

test("lease vencido no deja que un worker viejo sobrescriba la nueva programación", async () => {
  const entered = deferred(); const release = deferred(); let first = true;
  const h = queueHarness(1, { reconcile: async (orderId) => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return { result: "pending", orderId };
  } });
  const oldRun = h.create().run(); await entered.promise;
  h.advance(10 * MINUTE);
  assert.equal((await h.create().run()).checked, 1);
  const newer = h.get(`${QUEUE}/Order00000000`);
  release.resolve();
  assert.equal((await oldRun).leaseLost, 1);
  assert.deepEqual(h.get(`${QUEUE}/Order00000000`), newer);
});

test("errores consult tienen backoff y sólo conservan códigos, sin respuestas ni secretos", async () => {
  const h = queueHarness(1, { reconcile: async () => { throw new Error("sensitive-provider-response"); } });
  const worker = h.create();
  for (let i = 0; i < 8; i++) {
    const result = await worker.run();
    assert.equal(result.failed, 1);
    const entry = h.get(`${QUEUE}/Order00000000`);
    const delay = Math.min(6 * 60 * MINUTE, 5 * MINUTE * 2 ** i);
    assert.equal(entry.nextCheckAt, iso(h.clock() + delay));
    assert.equal(entry.consecutiveErrors, i + 1);
    assert.equal(entry.lastCode, "consult_failed");
    assert.equal(JSON.stringify(entry).includes("sensitive-provider-response"), false);
    h.advance(delay);
  }
});

test("deadline limita trabajo nuevo; los documentos restantes conservan su turno", async () => {
  let h;
  h = queueHarness(12, { reconcile: async (orderId) => {
    h.advance(7 * MINUTE);
    return { result: "pending", orderId };
  } });
  const result = await h.create().run();
  assert.ok(result.checked >= 1 && result.checked <= 4);
  assert.equal(result.deferred, 12 - result.checked);
  assert.equal(h.calls[0].config.deadline, START + 7 * MINUTE);
});
