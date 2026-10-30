"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");
const { makeSnapshot, snapshotFingerprint } = require("../lib/tilopayOrder");
const realPaypalApi = require("../lib/paypalApi");

const ROOT = path.resolve(__dirname, "..");
const OID = "Order12345678";
const ORDER = `orders/${OID}`;
const VARIANT = "products/p1/variants/v1";
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
const wrap = (...args) => args.at(-1);

function loadHandlers(seed, options = {}) {
  const memory = createMemoryFirestore(seed);
  const effects = { telegram: 0, email: 0, telegramMessages: [], emailMessages: [], crmCreated: 0, automations: [], paypal: [] };
  const cache = new Map();
  const dependencies = {
    "firebase-functions/v2/https": { onCall: wrap, HttpsError },
    "firebase-functions/v2/firestore": { onDocumentUpdated: (config, handler) => {
      effects.triggerOptions = config; return handler;
    } },
    "firebase-functions/v2/scheduler": { onSchedule: wrap },
    "firebase-functions/params": {
      defineSecret: (name) => {
        if (options.unavailableSecrets?.includes(name)) throw new Error(`Secret unavailable during endpoint discovery: ${name}`);
        return { value: () => "fake-test-secret" };
      },
      defineString: (name, defaults) => ({ value: () => name === "PAYPAL_APP_CLIENT_ID" ? "fake-id" : defaults?.default }),
    },
  };
  const specialFiles = {
    [path.join(ROOT, "utils.js")]: {
      db: memory.db, FieldValue: memory.FieldValue, generateOrderNumber: () => "AP-TEST",
      notifyAdminsTelegram: async (message) => {
        effects.telegram++; effects.telegramMessages.push(message);
        if (options.telegramError) throw new Error("ambiguous-send");
        return options.telegramResult || [{ chatId: "test", ok: true }];
      },
      logAutomation: async (value) => effects.automations.push(value),
    },
    [path.join(ROOT, "crm.js")]: { CRM_DEFAULT_FIELDS: { totalOrders: 0, totalSpent: 0 },
      updateCrmOnOrderCreated: async () => { effects.crmCreated++; } },
    [path.join(ROOT, "lib/orderEmail.js")]: { sendPaidOrderEmail: async (data) => {
      effects.email++; effects.emailData = data; effects.emailMessages.push(data);
      return options.emailResult || { result: "sent" };
    } },
    [path.join(ROOT, "lib/fx.js")]: { getFxRate: async () => ({ rate: 500, bufferPct: 0, source: "fixed", date: "2026-10-29" }), crcToUsd: (amount) => Number((amount / 500).toFixed(2)) },
    [path.join(ROOT, "lib/paypalApi.js")]: {
      ...realPaypalApi,
      getAccessToken: async () => "fake-token",
      ppFetch: async (url, config) => {
        effects.paypal.push({ url, config });
        if (options.onPaypal) return options.onPaypal(url, config, memory);
        return { ok: true, data: { id: "PP1", status: "APPROVED" } };
      },
    },
  };
  function load(filename) {
    // Pure shared validators use the same ESM implementation as the web client.
    if (filename.endsWith(".mjs")) return require(filename);
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
    new Function("require", "module", "exports", "__filename", "__dirname", "process", fs.readFileSync(filename, "utf8"))(
      localRequire, module, module.exports, filename, path.dirname(filename), options.env ? { env: options.env } : process);
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
function event(beforeStatus, afterStatus, time = new Date().toISOString()) {
  return { time, params: { orderId: OID }, data: { before: { data: () => ({ status: beforeStatus }) },
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

test("createOrder: SINPE y PayPal persisten notas del cliente sin cambiar finanzas, dueño ni notas internas", async () => {
  for (const paymentMethod of ["sinpe", "paypal"]) {
    const body = { customerName: "Ana", paymentMethod,
      uid: "other", customerUid: "other", subtotal: 1, total: 1, shippingCost: -1,
      depositTotal: 1, remainingTotal: 1, paymentStatus: "pagado", status: "enviado",
      notes: "No sobrescribir las notas internas",
      items: [{ productId: "p1", variantId: "v1", quantity: 2, price: 1, supplyType: "bajo_pedido" }] };
    const withoutNotes = loadHandlers(catalog());
    const baseline = await withoutNotes.orders.createOrderWithReservation(request(body));
    const withNotes = loadHandlers(catalog());
    const raw = '  Entregar después de las 3.\n{"total":1,"paymentStatus":"pagado"}  ';
    const created = await withNotes.orders.createOrderWithReservation(request({ ...body, customerNotes: raw }));
    const saved = withNotes.get(`orders/${created.orderId}`);
    assert.equal(saved.customerNotes, raw.trim());
    assert.equal(saved.notes, "");
    const comparable = (order) => {
      const copy = structuredClone(order);
      for (const key of ["customerNotes", "createdAt", "updatedAt"]) delete copy[key];
      if (copy.inventoryReservation) delete copy.inventoryReservation.createdAt;
      return copy;
    };
    assert.deepEqual(comparable(saved), comparable(withoutNotes.get(`orders/${baseline.orderId}`)));
    assert.equal(saved.total, 90000);
    assert.equal(saved.paymentStatus, "pendiente");
    assert.equal(saved.status, "pendiente_pago");
    assert.equal(saved.uid, "u1");
    assert.equal(withNotes.get(VARIANT).reservedStock, 2);
    assert.equal(withNotes.effects.paypal.length, 0);
  }
});

test("createOrder: notas opcionales admiten ausencia, vacío y límite exacto sin recortar contenido", async () => {
  for (const paymentMethod of ["sinpe", "paypal"]) {
    for (const value of [undefined, null, "", " \n\t ", "x".repeat(1000), `  ${"x".repeat(1000)}  `]) {
      const h = loadHandlers(catalog());
      const result = await h.orders.createOrderWithReservation(request({ customerName: "Ana", paymentMethod,
        ...(value === undefined ? {} : { customerNotes: value }),
        items: [{ productId: "p1", variantId: "v1", quantity: 1 }] }));
      const order = h.get(`orders/${result.orderId}`);
      assert.equal(order.customerNotes, typeof value === "string" ? value.trim() : "");
      assert.equal(order.total, 45000);
      assert.equal(order.paymentAmount, 0);
      assert.equal(order.paymentStatus, "pendiente");
    }
  }
});

test("createOrder: notas inválidas se rechazan antes de escribir pedido, reservar stock o ejecutar efectos", async () => {
  for (const paymentMethod of ["sinpe", "paypal"]) {
    for (const value of [false, 123, [], {}, { total: 1 }, "x".repeat(1001)]) {
      const h = loadHandlers(catalog());
      const original = structuredClone(h.store);
      await assert.rejects(h.orders.createOrderWithReservation(request({ customerName: "Ana", paymentMethod,
        customerNotes: value, items: [{ productId: "p1", variantId: "v1", quantity: 1 }] })),
      { code: "invalid-argument", message: typeof value === "string"
        ? "Las notas del pedido pueden tener hasta 1000 caracteres." : "Las notas del pedido deben ser texto." });
      assert.deepEqual(h.store, original);
      assert.equal(h.stats.commits, 0);
      assert.equal(h.effects.crmCreated + h.effects.telegram + h.effects.email, 0);
      assert.equal(h.effects.paypal.length, 0);
    }
  }
});

test("createOrder: persiste anticipo 50% solo Bajo pedido, saldo y líneas iguales al checkout", async () => {
  const seed = catalog();
  seed[VARIANT].price = 30000;
  seed["products/p2"] = { active: true, name: "Perfume bajo pedido", basePrice: 10000 };
  seed["products/p2/variants/v2"] = {
    active: true, name: "50 ml", price: 10000, supplyType: "bajo_pedido", stock: 0, reservedStock: 0,
  };
  const h = loadHandlers(seed);
  const result = await h.orders.createOrderWithReservation(request({
    customerName: "Ana", paymentMethod: "sinpe", shippingCost: 999,
    depositTotal: 1, backorderDeposit: 1, remainingTotal: 1,
    items: [
      { productId: "p1", variantId: "v1", quantity: 1, price: 1, supplyType: "bajo_pedido" },
      { productId: "p2", variantId: "v2", quantity: 1, price: 1, supplyType: "stock_propio" },
    ],
  }));
  const orderPath = `orders/${result.orderId}`;
  const order = h.get(orderPath);
  const { computeBackorder: computeClientBackorder } = await import("../../src/utils/backorder.js");
  const client = computeClientBackorder(order.itemsSummary, order.shippingCost);
  assert.equal(order.total, 40000);
  assert.equal(order.shippingCost, 0); // La tarifa real del catálogo sigue siendo envío incluido.
  assert.equal(order.hasBackorder, true);
  assert.equal(order.hasBackorderItems, true);
  assert.equal(order.depositTotal, 5000);
  assert.equal(order.backorderDeposit, 5000);
  assert.equal(order.remainingTotal, 5000);
  assert.equal(order.depositTotal, client.depositTotal);
  assert.equal(order.remainingTotal, client.balanceDue);
  assert.equal(order.total - order.remainingTotal, client.payNowTotal);
  assert.equal(client.payNowTotal, 35000); // Stock completo + mitad de Bajo pedido.
  assert.deepEqual(order.itemsSummary.map((line) => line.depositAmount), [0, 5000]);
  assert.equal(h.get(`${orderPath}/items/item_0`).depositAmount, 0);
  assert.equal(h.get(`${orderPath}/items/item_1`).depositAmount, 5000);
  assert.equal(order.itemsSummary.reduce((sum, line) => sum + line.depositAmount, 0), order.depositTotal);
  assert.deepEqual(order.inventoryReservation.lines, [{ productId: "p1", variantId: "v1", quantity: 1 }]);
  assert.equal(h.get(VARIANT).reservedStock, 1);
  assert.equal(h.get("products/p2/variants/v2").reservedStock, 0);
  assert.equal(order.paymentStatus, "pendiente");
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

test("paid trigger: invalid snapshots notify review without fulfillment; test payment has no effects", async () => {
  for (const [mutate, reviewNotice] of [
    [(order) => { delete order.tilopay.attemptsById.a1.snapshot; }, true],
    [(order) => { order.tilopay.attemptsById.a1.snapshot.lines[0].quantity = 99; }, true],
    [(order) => { order.paymentStatus = "test_paid"; order.tilopay.attemptsById.a1.mode = "test"; }, false],
  ]) {
    const seed = paidSeed(); mutate(seed[ORDER]);
    const h = loadHandlers(seed);
    await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
    assert.equal(h.get(VARIANT).stock, 10);
    assert.equal(h.get(VARIANT).reservedStock, 2);
    assert.equal(h.get("crm_contacts/u1"), undefined);
    assert.equal(h.effects.telegram + h.effects.email, reviewNotice ? 2 : 0);
    if (reviewNotice) assert.equal(h.effects.emailData.requiresReview, true);
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

test("paid trigger: later reconciliation notifies review; authorization alone never claims payment", async () => {
  for (const [mutate, reviewNotice] of [
    [(order) => { order.tilopay.reconciliationNeedsReview = true; }, true],
    [(order) => { order.tilopay.duplicatePaymentNeedsReview = true; }, true],
    [(order) => { order.tilopay.attemptsById.a1.financialEvidence = "authorized"; }, false],
  ]) {
    const seed = paidSeed(); mutate(seed[ORDER]);
    const h = loadHandlers(seed);
    await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
    assert.equal(h.get(VARIANT).stock, 10);
    assert.equal(h.get(ORDER).status, "revision_manual");
    assert.equal(h.effects.telegram + h.effects.email, reviewNotice ? 2 : 0);
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
  const provider = fakePaypalProvider();
  let changeMethod = false;
  const h = loadHandlers(paypalCatalog(), { onPaypal: async (url, config, memory) => {
    const result = await provider.fetch(url, config);
    if (changeMethod && config.method !== "POST") {
      await memory.db.doc(`orders/${created.orderId}`).update({ paymentMethod: "tilopay", tilopay: { attemptsById: {} } });
    }
    return result;
  } });
  const created = await createPaypalCheckout(h, [cartLine("p2", "v2")]);
  changeMethod = true;
  await assert.rejects(h.paypal.paypalCaptureOrder(request({ orderId: created.orderId, paypalOrderId: created.paypalOrderId })), { code: "failed-precondition" });
  assert.equal(provider.charges, 0);
  assert.equal(h.get(`orders/${created.orderId}`).paymentStatus, "pendiente");
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


test("paid review: duplicated/reordered events alert once per channel without inventory or CRM", async () => {
  const seed = paidSeed();
  seed[VARIANT] = { ...seed[VARIANT], stock: 0, reservedStock: 0 };
  const h = loadHandlers(seed);
  await Promise.all([
    h.orders.onOrderStatusChange(event("pendiente_pago", "pagado")),
    h.orders.onOrderStatusChange(event("pendiente_pago", "pagado")),
  ]);
  await Promise.all([
    h.orders.onOrderStatusChange(event("pagado", "revision_manual")),
    h.orders.onOrderStatusChange(event("pendiente_pago", "pagado")),
  ]);
  assert.equal(h.get(ORDER).status, "revision_manual");
  assert.equal(h.get(VARIANT).stock, 0);
  assert.equal(h.get("crm_contacts/u1"), undefined);
  assert.equal(h.effects.telegram, 1);
  assert.equal(h.effects.email, 1);
  assert.match(h.effects.telegramMessages[0], /Pagado pero requiere revisión/);
  assert.match(h.effects.telegramMessages[0], /TX1/);
  assert.match(h.effects.emailData.reviewReason, /Inventario insuficiente/);
  assert.equal(h.effects.emailData.requiresReview, true);
  assert.deepEqual(h.effects.emailData.items, []);
  assert.equal(h.get(ORDER).paidEffects.review.telegram.state, "sent");
  assert.equal(h.get(ORDER).paidEffects.review.email.state, "sent");
  assert.equal(h.get(ORDER).paidEffects.telegram, undefined);
  assert.equal(h.get(ORDER).paidEffects.email, undefined);
});

test("paid review and normal notices are independent in either order", async () => {
  for (const reviewFirst of [false, true]) {
    const seed = paidSeed();
    if (reviewFirst) Object.assign(seed[ORDER], { status: "revision_manual",
      fulfillment: { version: 1, state: "needs_review", reason: "Revisión administrativa" } });
    const h = loadHandlers(seed);
    if (reviewFirst) {
      await h.orders.onOrderStatusChange(event("pagado", "revision_manual"));
      await h.db.doc(ORDER).update({ status: "pagado" });
      await h.orders.onOrderStatusChange(event("revision_manual", "pagado"));
    } else {
      await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
      await h.db.doc(ORDER).update({ status: "revision_manual", "fulfillment.reason": "Revisión administrativa" });
      await h.orders.onOrderStatusChange(event("por_preparar", "revision_manual"));
    }
    await h.orders.onOrderStatusChange(event("pagado", "revision_manual"));
    assert.equal(h.effects.telegram, 2);
    assert.equal(h.effects.email, 2);
    assert.equal(h.effects.emailMessages.filter((mail) => mail.requiresReview).length, 1);
    assert.equal(h.effects.emailMessages.filter((mail) => !mail.requiresReview).length, 1);
    assert.equal(h.get(ORDER).paidEffects.telegram.state, "sent");
    assert.equal(h.get(ORDER).paidEffects.review.telegram.state, "sent");
    assert.equal(h.get(ORDER).paidEffects.email.state, "sent");
    assert.equal(h.get(ORDER).paidEffects.review.email.state, "sent");
    assert.equal(h.get(VARIANT).stock, 8);
    assert.equal(h.get("crm_contacts/u1").totalOrders, 1);
  }
});

test("paid review: unpaid, test, authorization and unlinked transactions never send alerts", async () => {
  for (const mutate of [
    (order) => { order.paymentStatus = "verificando"; },
    (order) => { order.paymentStatus = "test_paid"; },
    (order) => { order.tilopay.mode = "test"; },
    (order) => { order.tilopay.attemptsById.a1.mode = "test"; },
    (order) => { order.tilopay.attemptsById.a1.financialEvidence = "authorized"; },
    (order) => { order.tilopay.attemptsById.a1.status = "pending_capture"; },
    (order) => { delete order.tilopay.paidAttemptKey; },
    (order) => { order.paymentTransactionId = "OTHER"; },
    (order) => { order.status = "cancelado"; },
  ]) {
    const seed = paidSeed(); seed[ORDER].status = "revision_manual"; mutate(seed[ORDER]);
    const h = loadHandlers(seed);
    await h.orders.onOrderStatusChange(event("pagado", "revision_manual"));
    assert.equal(h.effects.telegram + h.effects.email, 0);
    assert.equal(h.get(ORDER).paidEffects, undefined);
    assert.equal(h.get(VARIANT).stock, 10);
    assert.equal(h.get("crm_contacts/u1"), undefined);
  }
});

test("paid review: an accredited manual payment is also reported without preparing the order", async () => {
  const seed = paidSeed(); delete seed[ORDER].tilopay;
  Object.assign(seed[ORDER], { paymentMethod: "sinpe", status: "revision_manual",
    fulfillment: { state: "needs_review", reason: "Falta resolver la entrega" } });
  const h = loadHandlers(seed);
  await h.orders.onOrderStatusChange(event("pagado", "revision_manual"));
  assert.equal(h.effects.telegram, 1);
  assert.equal(h.effects.email, 1);
  assert.equal(h.effects.emailData.requiresReview, true);
  assert.equal(h.get(VARIANT).stock, 10);
});

test("paid review: ambiguous delivery is recorded once and never retried blindly", async () => {
  const seed = paidSeed(); seed[ORDER].status = "revision_manual";
  const h = loadHandlers(seed, { telegramError: true, emailResult: { result: "error", reason: "SMTP ambiguous" } });
  await Promise.all([
    h.orders.onOrderStatusChange(event("pagado", "revision_manual")),
    h.orders.onOrderStatusChange(event("pagado", "revision_manual")),
  ]);
  await h.orders.onOrderStatusChange(event("pagado", "revision_manual"));
  assert.equal(h.effects.telegram, 1);
  assert.equal(h.effects.email, 1);
  assert.equal(h.get(ORDER).paidEffects.review.telegram.state, "needs_review");
  assert.equal(h.get(ORDER).paidEffects.review.email.state, "needs_review");
  assert.equal(h.get(ORDER).paidEffects.telegram, undefined);
});

test("order events older than one hour cause no stock, notification, release or automation effects", async () => {
  const expired = new Date(Date.now() - 61 * 60 * 1000).toISOString();
  for (const status of ["pagado", "revision_manual", "cancelado", "enviado", "entregado"]) {
    const seed = paidSeed(); Object.assign(seed[ORDER], { status, trackingNumber: "TRACK", updatedAt: new Date().toISOString() });
    const h = loadHandlers(seed);
    await h.orders.onOrderStatusChange(event("pendiente_pago", status, expired));
    assert.deepEqual(h.get(ORDER), seed[ORDER]);
    assert.deepEqual(h.get(VARIANT), seed[VARIANT]);
    assert.equal(h.effects.telegram + h.effects.email + h.effects.automations.length, 0);
    assert.equal(h.get("crm_contacts/u1"), undefined);
    assert.equal(h.stats.commits, 0);
  }
});

test("order event cutoff uses the original event time, accepts recent events and rejects invalid dates", async () => {
  const seed = paidSeed(); seed[ORDER].createdAt = "2020-01-01T00:00:00.000Z";
  const h = loadHandlers(seed);
  await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado", new Date(Date.now() - 59 * 60 * 1000).toISOString()));
  assert.equal(h.get(VARIANT).stock, 8);
  assert.equal(h.effects.telegram, 1);
  for (const time of [undefined, "invalid-date"]) {
    const invalid = loadHandlers(paidSeed());
    await invalid.orders.onOrderStatusChange({ ...event("pendiente_pago", "pagado"), time });
    assert.equal(invalid.get(VARIANT).stock, 10);
    assert.equal(invalid.effects.telegram + invalid.effects.email, 0);
  }
});


test("endpoint discovery does not resolve missing Gmail secrets; the trigger binds and reads them at runtime", async () => {
  const h = loadHandlers(paidSeed(), {
    unavailableSecrets: ["GMAIL_SMTP_USER", "GMAIL_SMTP_APP_PASSWORD"],
    env: { GMAIL_SMTP_USER: "sender@example.invalid", GMAIL_SMTP_APP_PASSWORD: "fake-runtime-password" },
  });
  assert.equal(h.effects.triggerOptions.retry, true);
  assert.ok(h.effects.triggerOptions.secrets.includes("GMAIL_SMTP_USER"));
  assert.ok(h.effects.triggerOptions.secrets.includes("GMAIL_SMTP_APP_PASSWORD"));
  await h.orders.onOrderStatusChange(event("pendiente_pago", "pagado"));
  assert.equal(h.effects.emailData.user, "sender@example.invalid");
  assert.equal(h.effects.emailData.pass, "fake-runtime-password");
});

// PayPal integration: actual canonical pricing, quote/capture handlers and API
// payload/validation helpers. Only transport, credentials and FX are test doubles.
function paypalCatalog() {
  const seed = catalog();
  seed[VARIANT].price = 47000;
  seed["products/p2"] = { active: true, name: "Rasasi", basePrice: 32000 };
  seed["products/p2/variants/v2"] = {
    active: true, name: "100 ml", price: 32000, supplyType: "bajo_pedido", stock: 0, reservedStock: 0,
  };
  return seed;
}
const cartLine = (productId, variantId, extra = {}) => ({ productId, variantId, quantity: 1, ...extra });
function fakePaypalProvider(options = {}) {
  const orders = new Map();
  const requests = new Map();
  let nextId = 0;
  const provider = { charges: 0, orders, options, async fetch(url, config = {}) {
    if (url === "/v2/checkout/orders" && config.method === "POST") {
      assert.ok(config.requestId, "every create must have a stable idempotency key");
      if (requests.has(config.requestId)) return structuredClone(requests.get(config.requestId));
      const id = `TESTPP${++nextId}`;
      const detail = { id, intent: config.body.intent, status: "APPROVED", purchase_units: structuredClone(config.body.purchase_units) };
      orders.set(id, detail);
      const response = { ok: true, status: 201, data: { id, status: "CREATED" } };
      requests.set(config.requestId, response);
      return structuredClone(response);
    }
    const match = /^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/.exec(url);
    assert.ok(match, `unexpected PayPal path: ${url}`);
    const order = orders.get(match[1]);
    assert.ok(order, `unknown PayPal order: ${match[1]}`);
    if (!match[2]) {
      const detail = structuredClone(order);
      if (options.detailPatch) options.detailPatch(detail);
      return { ok: true, status: 200, data: detail };
    }
    assert.equal(config.method, "POST");
    assert.ok(config.requestId, "capture must have an idempotency key");
    if (requests.has(config.requestId)) return structuredClone(requests.get(config.requestId));
    provider.charges++;
    order.status = "COMPLETED";
    const capture = { id: `CAP-${order.id}`, status: options.pending ? "PENDING" : "COMPLETED",
      amount: structuredClone(order.purchase_units[0].amount) };
    if (options.capturePatch) options.capturePatch(capture);
    order.purchase_units[0].payments = { captures: [capture] };
    const response = { ok: true, status: 201, data: structuredClone(order) };
    requests.set(config.requestId, response);
    return structuredClone(response);
  } };
  return provider;
}
async function createPaypalCheckout(h, items, extra = {}) {
  const quote = await h.paypal.paypalGetQuote({ data: { items, canton: "Grecia", shippingType: "normal" } });
  const result = await h.orders.createOrderWithReservation(request({
    customerName: "Ana", paymentMethod: "paypal", shippingAddress: { canton: "Grecia" }, items, ...extra,
  }));
  const pp = await h.paypal.paypalCreateOrder(request({ orderId: result.orderId, expectedQuote: quote }));
  return { ...result, ...pp, quote };
}

for (const scenario of [
  { name: "Rasasi Bajo pedido", items: [cartLine("p2", "v2", { price: 1, supplyType: "stock_propio" })], total: 32000, due: 16000, balance: 16000, deposit: 16000, usd: 32, stockQuantity: 0 },
  { name: "mixto: stock completo más apartado", items: [cartLine("p1", "v1", { price: 1, supplyType: "bajo_pedido" }), cartLine("p2", "v2", { price: 1, supplyType: "stock_propio" })], total: 79000, due: 63000, balance: 16000, deposit: 16000, usd: 126, stockQuantity: 1 },
  { name: "solo stock: pago completo", items: [cartLine("p1", "v1")], total: 47000, due: 47000, balance: 0, deposit: 0, usd: 94, stockQuantity: 1 },
]) {
  test(`PayPal quote/create/capture: ${scenario.name}; importes canónicos iguales a SINPE`, async () => {
    const provider = fakePaypalProvider();
    const h = loadHandlers(paypalCatalog(), { onPaypal: provider.fetch });
    const created = await createPaypalCheckout(h, scenario.items, {
      total: 1, subtotal: 1, shippingCost: -999, paymentAmount: 1,
      depositTotal: 1, remainingTotal: 1, backorderDeposit: 1,
    });
    const orderPath = `orders/${created.orderId}`;
    const quote = created.quote;
    assert.equal(quote.crcTotal, scenario.total);
    assert.equal(quote.crcPayNow, scenario.due);
    assert.equal(quote.crcBalanceDue, scenario.balance);
    assert.equal(quote.crcDepositTotal, scenario.deposit);
    assert.equal(Number(quote.usdTotal), scenario.usd);
    assert.equal(quote.crcShipping, 0); // El catálogo vigente incluye el envío.
    const { computeBackorder: computeClientBackorder } = await import("../../src/utils/backorder.js");
    const calculated = computeClientBackorder(h.get(orderPath).itemsSummary, 0);
    assert.equal(quote.crcPayNow, calculated.payNowTotal);
    assert.equal(quote.crcBalanceDue, calculated.balanceDue);
    const post = h.effects.paypal.find((call) => call.url === "/v2/checkout/orders");
    assert.equal(post.config.body.purchase_units[0].amount.value, scenario.usd.toFixed(2));
    assert.equal(post.config.body.purchase_units[0].amount.currency_code, "USD");
    assert.equal(post.config.body.purchase_units[0].custom_id, created.orderId);
    const result = await h.paypal.paypalCaptureOrder(request({ orderId: created.orderId, paypalOrderId: created.paypalOrderId,
      amount: 1, total: 1, remainingTotal: 0, paymentStatus: "pagado" }));
    assert.equal(result.result, "captured");
    assert.equal(result.partial, scenario.balance > 0);
    const order = h.get(orderPath);
    assert.equal(order.total, scenario.total);
    assert.equal(order.paymentAmount, scenario.due);
    assert.equal(order.remainingTotal, scenario.balance);
    assert.equal(order.paymentTransactionId, `CAP-${created.paypalOrderId}`);
    assert.equal(order.paymentStatus, scenario.balance ? "parcial" : "pagado");
    assert.equal(order.status, scenario.balance ? "pendiente_pago" : "pagado");
    if (scenario.balance) {
      assert.equal(order.depositStatus, "pagado");
      assert.equal(order.remainingStatus, "pendiente");
      assert.equal(order.backorderDepositPaid, true);
      assert.equal(order.backorderRemainingPaid, false);
      const bajo = order.itemsSummary.find((line) => line.supplyType === "bajo_pedido");
      assert.equal(bajo.depositPaid, true);
      assert.equal(bajo.remainingPaid, false);
      const item = h.get(`${orderPath}/items/${bajo.itemId}`);
      assert.equal(item.depositPaid, true);
      assert.equal(item.remainingPaid, false);
      // A deposit cannot trigger the full-payment fulfillment path.
      await h.orders.onOrderStatusChange({ ...event("pendiente_pago", "pendiente_pago"), params: { orderId: created.orderId } });
      assert.equal(h.get(orderPath).fulfillment, undefined);
      assert.equal(h.effects.telegram + h.effects.email, 0);
      assert.equal(h.get(VARIANT).stock, 10);
      assert.equal(h.get(VARIANT).reservedStock, scenario.stockQuantity);
    } else {
      const paidEvent = { ...event("pendiente_pago", "pagado"), params: { orderId: created.orderId } };
      await Promise.all([h.orders.onOrderStatusChange(paidEvent), h.orders.onOrderStatusChange(paidEvent)]);
      assert.equal(h.get(VARIANT).stock, 9);
      assert.equal(h.get(VARIANT).reservedStock, 0);
      assert.equal(h.get(orderPath).status, "por_preparar");
      assert.equal(h.effects.telegram, 1);
      assert.equal(h.effects.email, 1);
    }
    assert.equal(provider.charges, 1);
  });
}

test("PayPal rejects stale or forged displayed quote before contacting payment provider", async () => {
  const provider = fakePaypalProvider();
  const h = loadHandlers(paypalCatalog(), { onPaypal: provider.fetch });
  const items = [cartLine("p2", "v2")];
  const quote = await h.paypal.paypalGetQuote({ data: { items, canton: "Grecia" } });
  const { orderId } = await h.orders.createOrderWithReservation(request({ customerName: "Ana", paymentMethod: "paypal", items }));
  for (const expectedQuote of [undefined, null, {}, { crcTotal: 32000, usdTotal: 64, currency: "USD" },
    { ...quote, crcPayNow: 1 }, { ...quote, usdTotal: 1 }, { ...quote, crcBalanceDue: 0 }]) {
    await assert.rejects(h.paypal.paypalCreateOrder(request({ orderId, expectedQuote })), { code: "failed-precondition" });
  }
  assert.equal(h.effects.paypal.length, 0);
  await h.db.doc("products/p2/variants/v2").update({ price: 40000 });
  await assert.rejects(h.paypal.paypalCreateOrder(request({ orderId, expectedQuote: quote })), (error) => {
    assert.equal(error.code, "failed-precondition");
    assert.equal(error.details.quote.crcPayNow, 20000);
    assert.equal(error.details.quote.crcBalanceDue, 20000);
    return true;
  });
  assert.equal(h.effects.paypal.length, 0);
});

test("PayPal quote never accepts client supplyType, price, shipping or deposit as authority", async () => {
  const h = loadHandlers(paypalCatalog());
  const quote = await h.paypal.paypalGetQuote({ data: {
    items: [cartLine("p1", "v1", { price: 1, supplyType: "bajo_pedido" }), cartLine("p2", "v2", { price: 1, supplyType: "stock_propio" })],
    shippingCost: -100000, crcPayNow: 1, depositPercent: 0, remainingTotal: 0,
  } });
  assert.equal(quote.crcTotal, 79000);
  assert.equal(quote.crcPayNow, 63000);
  assert.equal(quote.crcBalanceDue, 16000);
  assert.equal(quote.crcBackorderSubtotal, 32000);
  assert.equal(quote.depositPercent, 0.5);
});

test("PayPal concurrent/retried create reuses one provider order and captures deposit only once", async () => {
  const provider = fakePaypalProvider();
  const h = loadHandlers(paypalCatalog(), { onPaypal: provider.fetch });
  const items = [cartLine("p2", "v2")];
  const quote = await h.paypal.paypalGetQuote({ data: { items, canton: "Grecia" } });
  const { orderId } = await h.orders.createOrderWithReservation(request({ customerName: "Ana", paymentMethod: "paypal", items }));
  const body = request({ orderId, expectedQuote: quote });
  const creates = await Promise.all([h.paypal.paypalCreateOrder(body), h.paypal.paypalCreateOrder(body)]);
  assert.equal(creates[0].paypalOrderId, creates[1].paypalOrderId);
  assert.equal(provider.orders.size, 1);
  const retried = await h.paypal.paypalCreateOrder(body);
  assert.equal(retried.paypalOrderId, creates[0].paypalOrderId);
  const capture = request({ orderId, paypalOrderId: retried.paypalOrderId });
  await Promise.all([h.paypal.paypalCaptureOrder(capture), h.paypal.paypalCaptureOrder(capture)]);
  await h.paypal.paypalCaptureOrder(capture);
  assert.equal(provider.charges, 1);
  assert.equal(h.get(`orders/${orderId}`).paymentAmount, 16000);
  assert.equal(h.get(`orders/${orderId}`).remainingTotal, 16000);
  assert.equal(h.get(`orders/${orderId}`).paymentStatus, "parcial");
  await assert.rejects(h.paypal.paypalCreateOrder(body), { code: "failed-precondition" });
  assert.equal(provider.orders.size, 1);
});

test("PayPal does not capture legacy full-total backorder attempts after deposit rollout", async () => {
  const h = loadHandlers({ ...paypalCatalog(), [ORDER]: baseOrder({ paymentMethod: "paypal", total: 32000,
    hasBackorder: true, backorderDeposit: 16000, remainingTotal: 16000,
    paypal: { orderId: "OLD-FULL", usdTotal: 64, crcTotal: 32000 } }),
    [`${ORDER}/items/item_0`]: { ...cartLine("p2", "v2"), lineTotal: 32000, price: 32000, supplyType: "bajo_pedido" },
  });
  await assert.rejects(h.paypal.paypalCaptureOrder(request({ paypalOrderId: "OLD-FULL" })), { code: "failed-precondition" });
  assert.equal(h.effects.paypal.length, 0);
  assert.equal(h.get(ORDER).paymentStatus, "pendiente");
});

test("PayPal create and capture cannot target another customer's order", async () => {
  const provider = fakePaypalProvider();
  const h = loadHandlers(paypalCatalog(), { onPaypal: provider.fetch });
  const created = await createPaypalCheckout(h, [cartLine("p2", "v2")]);
  const beforeCalls = h.effects.paypal.length;
  for (const auth of [undefined, { uid: "attacker" }]) {
    const code = auth ? "permission-denied" : "unauthenticated";
    await assert.rejects(h.paypal.paypalCreateOrder({ auth, data: { orderId: created.orderId, expectedQuote: created.quote } }), { code });
    await assert.rejects(h.paypal.paypalCaptureOrder({ auth, data: { orderId: created.orderId, paypalOrderId: created.paypalOrderId } }), { code });
  }
  assert.equal(h.effects.paypal.length, beforeCalls);
  assert.equal(provider.charges, 0);
});

for (const [label, mutate] of [
  ["amount", (detail) => { detail.purchase_units[0].amount.value = "64.00"; }],
  ["currency", (detail) => { detail.purchase_units[0].amount.currency_code = "EUR"; }],
  ["owner", (detail) => { detail.purchase_units[0].custom_id = "otherOrder"; }],
  ["provider order id", (detail) => { detail.id = "DIFFERENT-ORDER"; }],
]) {
  test(`PayPal rejects provider order ${label} mismatch before capture`, async () => {
    const provider = fakePaypalProvider();
    const h = loadHandlers(paypalCatalog(), { onPaypal: provider.fetch });
    const created = await createPaypalCheckout(h, [cartLine("p2", "v2")]);
    provider.options.detailPatch = mutate;
    await assert.rejects(h.paypal.paypalCaptureOrder(request({ orderId: created.orderId, paypalOrderId: created.paypalOrderId })), { code: "failed-precondition" });
    assert.equal(provider.charges, 0);
    assert.equal(h.get(`orders/${created.orderId}`).paymentStatus, "pendiente");
  });
}

for (const [label, mutate] of [
  ["amount", (capture) => { capture.amount.value = "64.00"; }],
  ["currency", (capture) => { capture.amount.currency_code = "EUR"; }],
]) {
  test(`PayPal never credits a capture with unexpected ${label}`, async () => {
    const provider = fakePaypalProvider({ capturePatch: mutate });
    const h = loadHandlers(paypalCatalog(), { onPaypal: provider.fetch });
    const created = await createPaypalCheckout(h, [cartLine("p2", "v2")]);
    await assert.rejects(h.paypal.paypalCaptureOrder(request({ orderId: created.orderId, paypalOrderId: created.paypalOrderId })), { code: "failed-precondition" });
    const order = h.get(`orders/${created.orderId}`);
    assert.notEqual(order.paymentStatus, "pagado");
    assert.notEqual(order.paymentStatus, "parcial");
    assert.equal(order.backorderDepositPaid, false);
    assert.equal(order.paymentAmount, 0);
    assert.equal(order.remainingTotal, 16000);
    assert.equal(h.effects.telegram + h.effects.email, 0);
  });
}

test("PayPal pending capture does not credit deposit until provider confirms completion", async () => {
  const provider = fakePaypalProvider({ pending: true });
  const h = loadHandlers(paypalCatalog(), { onPaypal: provider.fetch });
  const created = await createPaypalCheckout(h, [cartLine("p2", "v2")]);
  const body = request({ orderId: created.orderId, paypalOrderId: created.paypalOrderId });
  const pending = await h.paypal.paypalCaptureOrder(body);
  assert.equal(pending.result, "pending");
  assert.equal(h.get(`orders/${created.orderId}`).paymentStatus, "verificando");
  assert.equal(h.get(`orders/${created.orderId}`).backorderDepositPaid, false);
  assert.equal(h.get(`orders/${created.orderId}`).paymentAmount, 0);
  provider.orders.get(created.paypalOrderId).purchase_units[0].payments.captures[0].status = "COMPLETED";
  const completed = await h.paypal.paypalCaptureOrder(body);
  assert.equal(completed.result, "captured");
  assert.equal(h.get(`orders/${created.orderId}`).paymentStatus, "parcial");
  assert.equal(h.get(`orders/${created.orderId}`).remainingTotal, 16000);
  assert.equal(provider.charges, 1);
});

test("PayPal partial payment cannot be overwritten by manual proof or manual approval", async () => {
  const provider = fakePaypalProvider();
  const h = loadHandlers({ ...paypalCatalog(), "users_roles/admin": { role: "admin" } }, { onPaypal: provider.fetch });
  const created = await createPaypalCheckout(h, [cartLine("p2", "v2")]);
  await h.paypal.paypalCaptureOrder(request({ orderId: created.orderId, paypalOrderId: created.paypalOrderId }));
  const original = h.get(`orders/${created.orderId}`);
  await assert.rejects(h.payments.submitPaymentProof(request({ orderId: created.orderId, amount: 32000, transactionId: "FAKE" })), { code: "failed-precondition" });
  await assert.rejects(h.payments.approvePaymentManually(request({ orderId: created.orderId }, "admin")), { code: "failed-precondition" });
  assert.deepEqual(h.get(`orders/${created.orderId}`), original);
});

test("Legacy reservation cleanup never expires a paid PayPal backorder deposit", async () => {
  for (const paypalPatch of [{ paymentMethod: "paypal" }, { paymentMethod: "sinpe", paypal: { orderId: "PP1", captureStatus: "COMPLETED" } }]) {
    const h = loadHandlers({ ...paypalCatalog(), [ORDER]: baseOrder({ ...paypalPatch,
      createdAt: "2020-01-01T00:00:00.000Z", paymentStatus: "parcial", paymentAmount: 16000,
      total: 32000, remainingTotal: 16000, depositStatus: "pagado", backorderDepositPaid: true,
      reservedItems: [], // Bajo-pedido-only legacy carts have no stock reservation marker.
    }) });
    await h.schedulers.cleanExpiredReservations();
    assert.equal(h.get(ORDER).status, "pendiente_pago");
    assert.equal(h.get(ORDER).paymentStatus, "parcial");
    assert.equal(h.get(ORDER).legacyReservationReleasedAt, undefined);
    assert.equal(h.get(ORDER).paymentAmount, 16000);
  }
});


test("PayPal recovers a lost create response using the same immutable provider request", async () => {
  const provider = fakePaypalProvider();
  let responseLost = false;
  const h = loadHandlers(paypalCatalog(), { onPaypal: async (url, config) => {
    const response = await provider.fetch(url, config);
    if (!responseLost && url === "/v2/checkout/orders" && config.method === "POST") {
      responseLost = true;
      throw new Error("network response lost after provider created order");
    }
    return response;
  } });
  const items = [cartLine("p2", "v2")];
  const quote = await h.paypal.paypalGetQuote({ data: { items, canton: "Grecia" } });
  const { orderId } = await h.orders.createOrderWithReservation(request({ customerName: "Ana", paymentMethod: "paypal", items }));
  const body = request({ orderId, expectedQuote: quote });
  await assert.rejects(h.paypal.paypalCreateOrder(body));
  assert.equal(provider.orders.size, 1);
  const recovered = await h.paypal.paypalCreateOrder(body);
  assert.equal(provider.orders.size, 1);
  assert.equal(recovered.paypalOrderId, [...provider.orders.keys()][0]);
  const postIds = h.effects.paypal.filter(({ url }) => url === "/v2/checkout/orders").map(({ config }) => config.requestId);
  assert.equal(new Set(postIds).size, 1);
  assert.equal(h.get(`orders/${orderId}`).paypal.crcPayNow, 16000);
});

test("PayPal recovers a lost capture response without issuing a second charge", async () => {
  const provider = fakePaypalProvider();
  let responseLost = false;
  const h = loadHandlers(paypalCatalog(), { onPaypal: async (url, config) => {
    const response = await provider.fetch(url, config);
    if (!responseLost && url.endsWith("/capture")) {
      responseLost = true;
      throw new Error("network response lost after provider captured order");
    }
    return response;
  } });
  const created = await createPaypalCheckout(h, [cartLine("p2", "v2")]);
  const body = request({ orderId: created.orderId, paypalOrderId: created.paypalOrderId });
  await assert.rejects(h.paypal.paypalCaptureOrder(body));
  assert.equal(provider.charges, 1);
  assert.equal(h.get(`orders/${created.orderId}`).paymentAmount, 0);
  await h.paypal.paypalCaptureOrder(body);
  assert.equal(provider.charges, 1);
  assert.equal(h.effects.paypal.filter(({ url }) => url.endsWith("/capture")).length, 1);
  assert.equal(h.get(`orders/${created.orderId}`).paymentAmount, 16000);
  assert.equal(h.get(`orders/${created.orderId}`).remainingTotal, 16000);
  assert.equal(h.get(`orders/${created.orderId}`).paymentStatus, "parcial");
});

test("PayPal consults a minimal capture response before crediting the verified amount", async () => {
  const provider = fakePaypalProvider();
  const h = loadHandlers(paypalCatalog(), { onPaypal: async (url, config) => {
    const response = await provider.fetch(url, config);
    return url.endsWith("/capture") ? { ok: true, status: 201, data: { id: response.data.id, status: "COMPLETED" } } : response;
  } });
  const created = await createPaypalCheckout(h, [cartLine("p2", "v2")]);
  const result = await h.paypal.paypalCaptureOrder(request({ orderId: created.orderId, paypalOrderId: created.paypalOrderId }));
  assert.equal(result.result, "captured");
  assert.equal(provider.charges, 1);
  assert.equal(h.effects.paypal.filter(({ url, config }) => url === `/v2/checkout/orders/${created.paypalOrderId}` && config.method !== "POST").length, 2);
  assert.equal(h.get(`orders/${created.orderId}`).paymentAmount, 16000);
  assert.equal(h.get(`orders/${created.orderId}`).remainingTotal, 16000);
});

for (const switchType of ["stock_propio", "bajo_pedido"]) {
  test(`PayPal rejects catalog supplyType changed to ${switchType} after the inventory reservation`, async () => {
    const provider = fakePaypalProvider();
    const h = loadHandlers(paypalCatalog(), { onPaypal: provider.fetch });
    const item = switchType === "stock_propio" ? cartLine("p2", "v2") : cartLine("p1", "v1");
    const items = [item];
    const { orderId } = await h.orders.createOrderWithReservation(request({ customerName: "Ana", paymentMethod: "paypal", items }));
    const original = h.get(`orders/${orderId}`);
    await h.db.doc(`products/${item.productId}/variants/${item.variantId}`).update({ supplyType: switchType, stock: 10 });
    const quote = await h.paypal.paypalGetQuote({ data: { items, canton: "Grecia" } });
    await assert.rejects(h.paypal.paypalCreateOrder(request({ orderId, expectedQuote: quote })), { code: "failed-precondition" });
    assert.equal(h.effects.paypal.length, 0);
    assert.equal(provider.charges, 0);
    assert.deepEqual(h.get(`orders/${orderId}`).inventoryReservation, original.inventoryReservation);
    assert.equal(h.get(`orders/${orderId}`).paymentStatus, "pendiente");
  });
}

test("PayPal capture credits immutable approved lines even if mutable catalog and children changed", async () => {
  const provider = fakePaypalProvider();
  const h = loadHandlers(paypalCatalog(), { onPaypal: provider.fetch });
  const created = await createPaypalCheckout(h, [cartLine("p1", "v1"), cartLine("p2", "v2")]);
  const orderPath = `orders/${created.orderId}`;
  await h.db.doc("products/p2/variants/v2").update({ price: 99000, supplyType: "stock_propio" });
  await h.db.doc(`${orderPath}/items/item_1`).update({ price: 1, lineTotal: 1, supplyType: "stock_propio", quantity: 99 });
  await h.db.doc(`${orderPath}/items/injected`).set({ ...cartLine("p1", "v1"), quantity: 99, lineTotal: 1 });
  await h.db.doc(orderPath).update({ total: 1, remainingTotal: 0, itemsSummary: [] });
  await h.paypal.paypalCaptureOrder(request({ orderId: created.orderId, paypalOrderId: created.paypalOrderId }));
  const paid = h.get(orderPath);
  assert.equal(paid.total, 79000);
  assert.equal(paid.paymentAmount, 63000);
  assert.equal(paid.remainingTotal, 16000);
  assert.equal(paid.paymentStatus, "parcial");
  const backorder = paid.itemsSummary.find((line) => line.productId === "p2");
  assert.equal(backorder.supplyType, "bajo_pedido");
  assert.equal(backorder.lineTotal, 32000);
  assert.equal(backorder.quantity, 1);
  assert.equal(h.get(`${orderPath}/items/item_1`).lineTotal, 32000);
  assert.equal(h.get(`${orderPath}/items/injected`), undefined);
  assert.equal(provider.charges, 1);
});


test("PayPal rejects a stock order created without its canonical server reservation", async () => {
  const items = [cartLine("p1", "v1")];
  const h = loadHandlers({ ...paypalCatalog(),
    [ORDER]: baseOrder({ paymentMethod: "paypal", total: 47000, subtotal: 47000 }),
    [`${ORDER}/items/item_0`]: { ...items[0], price: 47000, lineTotal: 47000, supplyType: "stock_propio" },
  });
  const quote = await h.paypal.paypalGetQuote({ data: { items, canton: "Grecia" } });
  await assert.rejects(h.paypal.paypalCreateOrder(request({ expectedQuote: quote })), { code: "failed-precondition" });
  assert.equal(h.effects.paypal.length, 0);
  assert.equal(h.get(ORDER).paypal, undefined);
  assert.equal(h.get(ORDER).paymentStatus, "pendiente");
  assert.equal(h.get(VARIANT).reservedStock, 0);
});

test("PayPal does not resend an ambiguous create after its safe idempotency window", async () => {
  const provider = fakePaypalProvider();
  const h = loadHandlers(paypalCatalog(), { onPaypal: async (url, config) => {
    await provider.fetch(url, config);
    throw new Error("create response lost after PayPal accepted request");
  } });
  const items = [cartLine("p2", "v2")];
  const quote = await h.paypal.paypalGetQuote({ data: { items, canton: "Grecia" } });
  const { orderId } = await h.orders.createOrderWithReservation(request({ customerName: "Ana", paymentMethod: "paypal", items }));
  const body = request({ orderId, expectedQuote: quote });
  await assert.rejects(h.paypal.paypalCreateOrder(body));
  const orderPath = `orders/${orderId}`;
  assert.equal(h.get(orderPath).paypal.status, "CREATING");
  assert.equal(h.get(orderPath).paypal.orderId, "");
  const callCount = h.effects.paypal.length;
  await h.db.doc(orderPath).update({ "paypal.createdAt": new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() });
  await assert.rejects(h.paypal.paypalCreateOrder(body), { code: "failed-precondition" });
  assert.equal(h.effects.paypal.length, callCount);
  assert.equal(provider.orders.size, 1);
  assert.equal(provider.charges, 0);
  assert.equal(h.get(orderPath).paymentStatus, "pendiente");
});

test("PayPal already-paid legacy full payment does not reopen historical deposit balance", async () => {
  const seed = { [ORDER]: baseOrder({ paymentMethod: "paypal", total: 32000, subtotal: 32000,
    paymentStatus: "pagado", status: "pagado", paymentAmount: 32000,
    hasBackorder: true, backorderDeposit: 16000, remainingTotal: 16000,
    paypal: { orderId: "OLD-FULL", usdTotal: 64, crcTotal: 32000, captureStatus: "COMPLETED", captureId: "OLD-CAP" },
  }) };
  const h = loadHandlers(seed);
  const result = await h.paypal.paypalCaptureOrder(request({ paypalOrderId: "OLD-FULL" }));
  assert.equal(result.result, "already_paid");
  assert.equal(result.partial, false);
  assert.equal(result.crcPayNow, 32000);
  assert.equal(result.crcBalanceDue, 0);
  assert.equal(result.captureId, "OLD-CAP");
  assert.equal(h.effects.paypal.length, 0);
  assert.deepEqual(h.get(ORDER), seed[ORDER]);
});


test("PayPal capture representation without purchase-unit binding is consulted before credit", async () => {
  const provider = fakePaypalProvider();
  const h = loadHandlers(paypalCatalog(), { onPaypal: async (url, config) => {
    const response = await provider.fetch(url, config);
    if (url.endsWith("/capture")) {
      // Orders v2 capture responses may include capture amount/currency/status
      // while omitting the parent purchase unit's custom_id and amount.
      delete response.data.purchase_units[0].custom_id;
      delete response.data.purchase_units[0].amount;
    }
    return response;
  } });
  const created = await createPaypalCheckout(h, [cartLine("p2", "v2")]);
  const result = await h.paypal.paypalCaptureOrder(request({ orderId: created.orderId, paypalOrderId: created.paypalOrderId }));
  assert.equal(result.result, "captured");
  assert.equal(result.partial, true);
  assert.equal(provider.charges, 1);
  assert.equal(h.effects.paypal.filter(({ url }) => url.endsWith("/capture")).length, 1);
  assert.equal(h.effects.paypal.filter(({ url, config }) => url === `/v2/checkout/orders/${created.paypalOrderId}` && config.method !== "POST").length, 2);
  assert.equal(h.get(`orders/${created.orderId}`).paymentStatus, "parcial");
  assert.equal(h.get(`orders/${created.orderId}`).paymentAmount, 16000);
  assert.equal(h.get(`orders/${created.orderId}`).remainingTotal, 16000);
});
