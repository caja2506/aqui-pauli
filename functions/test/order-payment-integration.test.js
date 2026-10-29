"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");
const { makeSnapshot, snapshotFingerprint } = require("../lib/tilopayOrder");

const ROOT = path.resolve(__dirname, "..");
const OID = "Order12345678";
const ORDER = `orders/${OID}`;
const VARIANT = "products/p1/variants/v1";
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const wrap = (...args) => args.at(-1);

function loadHandlers(seed, options = {}) {
  const memory = createMemoryFirestore(seed);
  const effects = { telegram: 0, email: 0, crmCreated: 0, automations: [], paypal: [] };
  const cache = new Map();
  const dependencies = {
    "firebase-functions/v2/https": { onCall: wrap, HttpsError },
    "firebase-functions/v2/firestore": { onDocumentUpdated: wrap },
    "firebase-functions/v2/scheduler": { onSchedule: wrap },
    "firebase-functions/params": {
      defineSecret: () => ({ value: () => "fake-test-secret" }),
      defineString: (name, defaults) => ({ value: () => name === "PAYPAL_APP_CLIENT_ID" ? "fake-id" : defaults?.default }),
    },
  };
  const specialFiles = {
    [path.join(ROOT, "utils.js")]: {
      db: memory.db, FieldValue: memory.FieldValue, generateOrderNumber: () => "AP-TEST",
      notifyAdminsTelegram: async () => {
        effects.telegram++;
        if (options.telegramError) throw new Error("ambiguous-send");
        return options.telegramResult || [{ chatId: "test", ok: true }];
      },
      logAutomation: async (value) => effects.automations.push(value),
    },
    [path.join(ROOT, "crm.js")]: { CRM_DEFAULT_FIELDS: { totalOrders: 0, totalSpent: 0 },
      updateCrmOnOrderCreated: async () => { effects.crmCreated++; } },
    [path.join(ROOT, "lib/orderEmail.js")]: { sendPaidOrderEmail: async (data) => {
      effects.email++; effects.emailData = data; return { result: "sent" };
    } },
    [path.join(ROOT, "lib/fx.js")]: { getFxRate: async () => ({ rate: 500, bufferPct: 0 }), crcToUsd: (amount) => (amount / 500).toFixed(2) },
    [path.join(ROOT, "lib/paypalApi.js")]: {
      getAccessToken: async () => "fake-token", buildOrderPayload: (data) => data,
      verifyOrderMatches: () => null,
      interpretCapture: () => ({ state: "completed", capture: { id: "CAP1", status: "COMPLETED", amount: { value: "180.00" } } }),
      ppFetch: async (url, config) => {
        effects.paypal.push({ url, config });
        if (options.onPaypal) return options.onPaypal(url, config, memory);
        return { ok: true, data: { id: "PP1", status: "APPROVED" } };
      },
    },
  };
  function load(filename) {
    filename = filename.endsWith(".js") ? filename : `${filename}.js`;
    if (specialFiles[filename]) return specialFiles[filename];
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = (name) => {
      if (dependencies[name]) return dependencies[name];
      return name.startsWith(".") ? load(path.resolve(path.dirname(filename), name)) : require(name);
    };
    // Isolated CommonJS dependency injection: no Firebase, SMTP, Telegram or PayPal requests.
    new Function("require", "module", "exports", "__filename", "__dirname", fs.readFileSync(filename, "utf8"))(
      localRequire, module, module.exports, filename, path.dirname(filename));
    return module.exports;
  }
  return { ...memory, effects, orders: load(path.join(ROOT, "orders.js")),
    payments: load(path.join(ROOT, "payments.js")), paypal: load(path.join(ROOT, "paypal.js")),
    schedulers: load(path.join(ROOT, "schedulers.js")) };
}

function catalog() {
  return { "products/p1": { active: true, name: "Perfume", basePrice: 50000 },
    [VARIANT]: { active: true, name: "100 ml", price: 45000, supplyType: "stock_propio", stock: 10, reservedStock: 0 } };
}
function baseOrder(extra = {}) {
  return { uid: "u1", customerUid: "u1", customerName: "Ana", customerEmail: "ana@example.invalid", customerPhone: "88887777",
    orderNumber: "AP-TEST", paymentMethod: "tilopay", total: 90000, subtotal: 90000, shippingCost: 0,
    shippingType: "normal", shippingAddress: { canton: "Grecia" }, status: "pendiente_pago", paymentStatus: "pendiente", ...extra };
}
function paidSeed({ reserved = true } = {}) {
  const order = baseOrder({ status: "pagado", paymentStatus: "pagado", paymentAmount: 90000, paymentTransactionId: "TX1" });
  const snapshot = makeSnapshot(order, [{ itemId: "item_0", productId: "p1", variantId: "v1", quantity: 2,
    unitPrice: 45000, lineTotal: 90000, productName: "Perfume", variantName: "100 ml", imageUrl: "", supplyType: "stock_propio" }],
  { subtotal: 90000, shippingCost: 0, total: 90000 });
  order.tilopay = { mode: "live", paidAttemptKey: "a1", attemptsById: { a1: {
    schemaVersion: 2, status: "approved", mode: "live", snapshot, orderVersion: snapshotFingerprint(snapshot),
    idTilopay: "TX1", financialEvidence: "captured", validatedAmountMinor: 9000000,
  } } };
  if (reserved) order.inventoryReservation = { version: 1, state: "reserved",
    lines: [{ productId: "p1", variantId: "v1", quantity: 2 }] };
  const seed = { ...catalog(), [ORDER]: order,
    // Malicious/stale child data must not replace the paid Tilopay snapshot.
    [`${ORDER}/items/item_0`]: { productId: "p1", variantId: "v1", quantity: 99, supplyType: "bajo_pedido", price: 1 } };
  seed[VARIANT].reservedStock = reserved ? 2 : 3;
  return seed;
}
const request = (data = {}, uid = "u1") => ({ auth: { uid }, data: { orderId: OID, ...data } });
function event(beforeStatus, afterStatus) {
  return { params: { orderId: OID }, data: { before: { data: () => ({ status: beforeStatus }) },
    after: { data: () => ({ status: afterStatus }) } } };
}

test("createOrder: canonical prices/supplyType/owner; ignores client financial fields", async () => {
  const h = loadHandlers(catalog());
  const result = await h.orders.createOrderWithReservation(request({ customerName: "Ana", paymentMethod: "sinpe",
    subtotal: 1, shippingCost: -999, paymentStatus: "pagado", tilopay: { paid: true },
    items: [{ productId: "p1", variantId: "v1", quantity: 2, price: 1, supplyType: "bajo_pedido" }] }));
  const order = h.get(`orders/${result.orderId}`);
  assert.equal(order.total, 90000);
  assert.equal(order.shippingCost, 0);
  assert.equal(order.paymentStatus, "pendiente");
  assert.equal(order.tilopay, undefined);
  assert.equal(order.uid, "u1");
  assert.equal(order.itemsSummary[0].supplyType, "stock_propio");
  assert.equal(h.get(VARIANT).reservedStock, 2);
  assert.equal(order.inventoryReservation.state, "reserved");
});

test("createOrder: duplicate and invalid quantities make no reservation", async () => {
  for (const items of [
    [{ productId: "p1", variantId: "v1", quantity: -2 }],
    [{ productId: "p1", variantId: "v1", quantity: "2" }],
    [{ productId: "p1", variantId: "v1", quantity: 1 }, { productId: "p1", variantId: "v1", quantity: 1 }],
  ]) {
    const h = loadHandlers(catalog());
    await assert.rejects(h.orders.createOrderWithReservation(request({ customerName: "Ana", paymentMethod: "sinpe", items })), { code: "invalid-argument" });
    assert.equal(h.get(VARIANT).reservedStock, 0);
    assert.equal(Object.keys(h.store).filter((key) => key.startsWith("orders/")).length, 0);
  }
});

test("createOrder: simultaneous reservations cannot oversell catalog stock", async () => {
  const seed = catalog(); seed[VARIANT].stock = 2;
  const h = loadHandlers(seed);
  const body = request({ customerName: "Ana", paymentMethod: "sinpe", items: [{ productId: "p1", variantId: "v1", quantity: 2 }] });
  const results = await Promise.allSettled([h.orders.createOrderWithReservation(body), h.orders.createOrderWithReservation(body)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(h.get(VARIANT).reservedStock, 2);
  assert.ok(h.stats.retries > 0);
});

test("createOrder: Tilopay creation defers inventory and CRM to live payment flow", async () => {
  const h = loadHandlers(catalog());
  const result = await h.orders.createOrderWithReservation(request({ customerName: "Ana", paymentMethod: "tilopay",
    items: [{ productId: "p1", variantId: "v1", quantity: 2 }] }));
  assert.equal(h.get(VARIANT).reservedStock, 0);
  assert.equal(h.get(`orders/${result.orderId}`).inventoryReservation, undefined);
  assert.equal(h.effects.crmCreated, 0);
});

test("paid trigger: duplicated concurrent events consume only snapshot, stock/CRM once", async () => {
  const h = loadHandlers(paidSeed());
  await Promise.all([h.orders.onOrderStatusChange(event("pendiente_pago", "pagado")), h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"))]);
  assert.equal(h.get(VARIANT).stock, 8);
  assert.equal(h.get(VARIANT).reservedStock, 0);
  assert.equal(h.get(ORDER).status, "por_preparar");
  assert.equal(h.get(ORDER).inventoryReservation.state, "consumed");
  assert.equal(h.get("crm_contacts/u1").totalOrders, 1);
  assert.equal(h.get("crm_contacts/u1").totalSpent, 90000);
  assert.equal(h.effects.emailData.items[0].quantity, 2);
  assert.equal(h.effects.telegram, 1);
  assert.equal(h.effects.email, 1);
});

test("paid trigger: no server reservation means no decrement of another order's reserved stock", async () => {
  const h = loadHandlers(paidSeed({ reserved: false }));
  await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
  assert.equal(h.get(VARIANT).stock, 8);
  assert.equal(h.get(VARIANT).reservedStock, 3);
});

test("paid trigger: legacy, tampered fingerprint and test payment have no fulfillment effects", async () => {
  for (const mutate of [
    (order) => { delete order.tilopay.attemptsById.a1.snapshot; },
    (order) => { order.tilopay.attemptsById.a1.snapshot.lines[0].quantity = 99; },
    (order) => { order.paymentStatus = "test_paid"; order.tilopay.attemptsById.a1.mode = "test"; },
  ]) {
    const seed = paidSeed(); mutate(seed[ORDER]);
    const h = loadHandlers(seed);
    await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
    assert.equal(h.get(VARIANT).stock, 10);
    assert.equal(h.get(VARIANT).reservedStock, 2);
    assert.equal(h.get("crm_contacts/u1"), undefined);
    assert.equal(h.effects.telegram + h.effects.email, 0);
    assert.notEqual(h.get(ORDER).status, "por_preparar");
  }
});

test("paid trigger: stale event cannot reopen a currently canceled order", async () => {
  const seed = paidSeed(); seed[ORDER].status = "cancelado";
  const h = loadHandlers(seed);
  await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
  assert.equal(h.get(ORDER).status, "cancelado");
  assert.equal(h.get(VARIANT).stock, 10);
  assert.equal(h.effects.telegram + h.effects.email, 0);
});

test("paid trigger: later refund/reconciliation and authorized-only evidence block delivery", async () => {
  for (const mutate of [
    (order) => { order.tilopay.reconciliationNeedsReview = true; },
    (order) => { order.tilopay.duplicatePaymentNeedsReview = true; },
    (order) => { order.tilopay.attemptsById.a1.financialEvidence = "authorized"; },
  ]) {
    const seed = paidSeed(); mutate(seed[ORDER]);
    const h = loadHandlers(seed);
    await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
    assert.equal(h.get(VARIANT).stock, 10);
    assert.equal(h.get(ORDER).status, "revision_manual");
    assert.equal(h.effects.telegram + h.effects.email, 0);
  }
});

test("test and stale shipped events never enqueue commercial tracking", async () => {
  for (const patch of [{ paymentStatus: "test_paid", status: "enviado" }, { status: "cancelado" }]) {
    const seed = paidSeed(); Object.assign(seed[ORDER], patch, { trackingNumber: "TRACK" });
    const h = loadHandlers(seed);
    await h.orders.onOrderStatusChange(event("por_preparar", "enviado"));
    assert.equal(h.effects.automations.length, 0);
  }
});

test("paid trigger: cancellation racing transaction commit aborts inventory/CRM writes", async () => {
  const h = loadHandlers(paidSeed());
  let changed = false;
  h.db.beforeCommit = async ({ writes }) => {
    if (!changed && writes.some(([kind, key]) => kind === "update" && key === VARIANT)) {
      changed = true;
      await h.db.doc(ORDER).update({ status: "cancelado" });
    }
  };
  await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
  assert.equal(h.get(ORDER).status, "cancelado");
  assert.equal(h.get(VARIANT).stock, 10);
  assert.equal(h.get("crm_contacts/u1"), undefined);
  assert.ok(h.stats.retries > 0);
});

test("cancel trigger: duplicated delivery releases a server reservation only once", async () => {
  const seed = paidSeed(); seed[ORDER].status = "cancelado"; seed[ORDER].paymentStatus = "pendiente";
  const h = loadHandlers(seed);
  await Promise.all([h.orders.onOrderStatusChange(event("pendiente_pago", "cancelado")), h.orders.onOrderStatusChange(event("pendiente_pago", "cancelado"))]);
  assert.equal(h.get(VARIANT).reservedStock, 0);
  assert.equal(h.get(VARIANT).stock, 10);
  assert.equal(h.get(ORDER).inventoryReservation.state, "released");
});

test("deleteOrder: Tilopay references survive admin deletion attempt even if method changed", async () => {
  for (const order of [baseOrder(), baseOrder({ paymentMethod: "sinpe", tilopay: {} })]) {
    const h = loadHandlers({ ...catalog(), [ORDER]: order, "users_roles/admin": { role: "admin" } });
    await assert.rejects(h.orders.deleteOrder(request({}, "admin")), { code: "failed-precondition" });
    assert.ok(h.get(ORDER));
  }
});

test("delete/cancel concurrency cannot double-release a non-Tilopay reservation", async () => {
  const seed = paidSeed(); delete seed[ORDER].tilopay; seed[ORDER].paymentMethod = "sinpe";
  seed[ORDER].status = "cancelado"; seed[ORDER].paymentStatus = "pendiente";
  seed["users_roles/admin"] = { role: "admin" };
  const h = loadHandlers(seed);
  await Promise.all([h.orders.deleteOrder(request({}, "admin")), h.orders.onOrderStatusChange(event("pendiente_pago", "cancelado"))]);
  assert.equal(h.get(ORDER), undefined);
  assert.equal(h.get(VARIANT).reservedStock, 0);
  assert.equal(h.get(VARIANT).stock, 10);
});

test("manual routes reject Tilopay method, hidden attempt and test_paid", async () => {
  for (const order of [baseOrder(), baseOrder({ paymentMethod: "sinpe", tilopay: {} }), baseOrder({ paymentMethod: "sinpe", paymentStatus: "test_paid" })]) {
    const h = loadHandlers({ [ORDER]: order, "users_roles/admin": { role: "admin" } });
    await assert.rejects(h.payments.submitPaymentProof(request({ amount: 90000 })), { code: "failed-precondition" });
    await assert.rejects(h.payments.approvePaymentManually(request({}, "admin")), { code: "failed-precondition" });
    assert.equal(h.get(ORDER).paymentStatus, order.paymentStatus);
  }
});

test("manual proof/approval remain available for real manual orders and are transactional", async () => {
  const order = baseOrder({ paymentMethod: "sinpe" }); delete order.customerUid;
  const h = loadHandlers({ [ORDER]: order, "users_roles/admin": { role: "admin" } });
  await assert.rejects(h.payments.submitPaymentProof(request({ amount: 90000 }, "intruder")), { code: "permission-denied" });
  assert.equal((await h.payments.submitPaymentProof(request({ amount: 90000 }))).result, "submitted");
  assert.equal(h.get(ORDER).status, "pendiente_pago");
  const results = await Promise.all([h.payments.approvePaymentManually(request({}, "admin")), h.payments.approvePaymentManually(request({}, "admin"))]);
  assert.deepEqual(results.map((result) => result.result).sort(), ["already_paid", "approved"]);
});

test("manual proof cannot race a newly attached Tilopay attempt", async () => {
  const h = loadHandlers({ [ORDER]: baseOrder({ paymentMethod: "sinpe" }) });
  let changed = false;
  h.db.beforeCommit = async ({ writes }) => {
    if (!changed && writes.some(([, key]) => key === ORDER)) {
      changed = true;
      await h.db.doc(ORDER).update({ paymentMethod: "tilopay", tilopay: { attemptsById: {} } });
    }
  };
  await assert.rejects(h.payments.submitPaymentProof(request({ amount: 1 })), { code: "failed-precondition" });
  assert.equal(h.get(ORDER).paymentStatus, "pendiente");
  assert.equal(h.get(ORDER).paymentAmount, undefined);
});

test("ambiguous external notice is recorded for review and never resent on trigger retry", async () => {
  const h = loadHandlers(paidSeed(), { telegramError: true });
  await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
  await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
  assert.equal(h.effects.telegram, 1);
  assert.equal(h.get(ORDER).paidEffects.telegram.state, "needs_review");
  assert.equal(h.get(VARIANT).stock, 8);
  assert.equal(h.get("crm_contacts/u1").totalOrders, 1);
});

test("PayPal create/capture reject a Tilopay order before contacting provider", async () => {
  const h = loadHandlers({ [ORDER]: baseOrder({ paypal: { orderId: "PP1", usdTotal: "180.00" } }) });
  await assert.rejects(h.paypal.paypalCreateOrder(request()), { code: "failed-precondition" });
  await assert.rejects(h.paypal.paypalCaptureOrder(request({ paypalOrderId: "PP1" })), { code: "failed-precondition" });
  assert.equal(h.effects.paypal.length, 0);
});

test("Telegram partial failure returned by utils is review, never a claimed success", async () => {
  const h = loadHandlers(paidSeed(), { telegramResult: [{ chatId: "one", ok: true }, { chatId: "two", ok: false }] });
  await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
  await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
  assert.equal(h.get(ORDER).paidEffects.telegram.state, "needs_review");
  assert.equal(h.effects.telegram, 1);
});

test("PayPal capture rechecks method after provider consultation and before capture", async () => {
  const h = loadHandlers({ [ORDER]: baseOrder({ paymentMethod: "paypal", paypal: { orderId: "PP1", usdTotal: "180.00" } }) }, {
    onPaypal: async (url, _config, memory) => {
      assert.equal(url, "/v2/checkout/orders/PP1");
      await memory.db.doc(ORDER).update({ paymentMethod: "tilopay", tilopay: { attemptsById: {} } });
      return { ok: true, data: { id: "PP1", status: "APPROVED" } };
    },
  });
  await assert.rejects(h.paypal.paypalCaptureOrder(request({ paypalOrderId: "PP1" })), { code: "failed-precondition" });
  assert.equal(h.effects.paypal.length, 1);
  assert.equal(h.get(ORDER).paymentStatus, "pendiente");
});

function legacyReservationSeed(patch = {}) {
  const seed = catalog();
  seed[VARIANT].reservedStock = 2;
  seed[ORDER] = baseOrder({ paymentMethod: "sinpe", createdAt: "2020-01-01T00:00:00.000Z",
    reservedItems: [{ productId: "p1", variantId: "v1", quantity: 1 }, { productId: "p1", variantId: "v1", quantity: 1 }], ...patch });
  return seed;
}

test("legacy expiry skips Tilopay and all new inventory/fulfillment markers", async () => {
  for (const patch of [{ paymentMethod: "tilopay" }, { tilopay: {} }, { inventoryReservation: {} }, { fulfillment: {} }]) {
    const h = loadHandlers(legacyReservationSeed(patch));
    await h.schedulers.cleanExpiredReservations();
    assert.equal(h.get(ORDER).status, "pendiente_pago");
    assert.equal(h.get(VARIANT).reservedStock, 2);
  }
});

test("legacy expiry rereads after race with payment start and never commits a stale release", async () => {
  const h = loadHandlers(legacyReservationSeed());
  let started = false;
  h.db.beforeCommit = async ({ writes }) => {
    if (!started && writes.some(([, key]) => key === VARIANT)) {
      started = true;
      await h.db.doc(ORDER).update({ paymentMethod: "tilopay", tilopay: { attemptsById: { a1: { status: "reserved" } } } });
    }
  };
  await h.schedulers.cleanExpiredReservations();
  assert.equal(h.get(ORDER).status, "pendiente_pago");
  assert.equal(h.get(ORDER).legacyReservationReleasedAt, undefined);
  assert.equal(h.get(VARIANT).reservedStock, 2);
  assert.ok(h.stats.retries > 0);
});

test("legacy expiry concurrent events release grouped quantities once and reject inconsistent stock", async () => {
  const h = loadHandlers(legacyReservationSeed());
  await Promise.all([h.schedulers.cleanExpiredReservations(), h.schedulers.cleanExpiredReservations()]);
  assert.equal(h.get(ORDER).status, "expirado");
  assert.ok(h.get(ORDER).legacyReservationReleasedAt);
  assert.equal(h.get(VARIANT).reservedStock, 0);
  assert.equal(h.get(VARIANT).stock, 10);
  // Even a status-only reset cannot release the same legacy reservation a second time.
  await h.db.doc(ORDER).update({ status: "pendiente_pago" });
  await h.schedulers.cleanExpiredReservations();
  assert.equal(h.get(VARIANT).reservedStock, 0);
  const invalid = legacyReservationSeed(); invalid[VARIANT].reservedStock = 1;
  const bad = loadHandlers(invalid);
  await bad.schedulers.cleanExpiredReservations();
  assert.equal(bad.get(ORDER).status, "pendiente_pago");
  assert.equal(bad.get(VARIANT).reservedStock, 1);
});
