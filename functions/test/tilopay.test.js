"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const tp = require("../lib/tilopayApi");
const { createTilopayService } = require("../lib/tilopayService");
const { snapshotFingerprint, makeSnapshot, validateSnapshotAmounts, quoteFromSnapshot } = require("../lib/tilopayOrder");
const { computeBackorder } = require("../lib/backorderDeposit");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");

class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
const ORDER = "OrderOne12345678";
const KEY = "test-key-not-a-credential";
const MERCHANT = "88803956";
const PREFIX = "PFC031932";
const URL = "https://secure.tilopay.com/htmls/test.html";
const request = (id = ORDER, uid = "user1") => ({ auth: { uid }, data: { orderId: id } });
const response = (data, ok = true, status = 200) => ({ ok, status, data, jsonValid: true });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const orderData = () => ({ uid: "user1", orderNumber: "VISIBLE-CLIENT-NUMBER",
  paymentMethod: "tilopay", paymentStatus: "pendiente", status: "pendiente_pago",
  total: 1, subtotal: 1, shippingCost: 0, shippingType: "normal",
  customerName: "Ana Perez", customerEmail: "ana@example.com", customerPhone: "88887777",
  shippingAddress: { provincia: "Alajuela", canton: "Grecia", distrito: "Grecia", codigoPostal: "20301", señas: "Casa" },
  itemsSummary: [{ productId: "wrong", variantId: "wrong", quantity: 99, price: 1 }],
});
const seed = (mode = "live") => ({
  "config/payments": { tilopay: { enabled: true, mode, merchantId: MERCHANT, orderPrefix: PREFIX } },
  "users_roles/user1": { role: "tester" },
  "products/p1": { name: "Eros", active: true, basePrice: 50000 },
  "products/p1/variants/v1": { name: "100ml", price: 45000, stock: 100, reservedStock: 0, supplyType: "stock_propio" },
  [`orders/${ORDER}`]: orderData(),
  [`orders/${ORDER}/items/item_0`]: { productId: "p1", variantId: "v1", quantity: 2, price: 1,
    supplyType: "bajo_pedido", productName: "Client name" },
});

function harness({ mode = "live", extra = {}, onPay, onConsult, credentials } = {}) {
  const mem = createMemoryFirestore({ ...seed(mode), ...extra });
  const calls = { pay: [], consult: [], credentials: 0, token: 0, quoteErrors: [] };
  let nonce = 0;
  let time = Date.UTC(2026, 9, 29, 10);
  const bank = new Map();
  const api = { ...tp, getToken: async () => { calls.token++; return "TOKEN"; },
    tpFetch: async (path, options) => {
      if (path.endsWith("processPayment")) {
        calls.pay.push(options.body);
        return onPay ? onPay(options.body, mem) : response({ type: "100", url: URL });
      }
      if (path.endsWith("consult")) {
        calls.consult.push(options.body);
        return onConsult ? onConsult(options.body, mem) : response({ type: "200", message: "", response: bank.get(options.body.orderNumber) || [] });
      }
      throw new Error("Unexpected API operation");
    },
  };
  const service = createTilopayService({ db: mem.db, api, HttpsError,
    onQuoteError: event => calls.quoteErrors.push(event),
    credentials: () => { calls.credentials++; return credentials ? credentials() : { apiUser: "u", password: "p", key: KEY }; },
    returnBase: () => "https://aquipauli.com",
    clock: () => time, randomId: () => String(++nonce).padStart(32, "0") });
  const order = (id = ORDER) => mem.get(`orders/${id}`);
  const att = (id = ORDER, key = "a1") => order(id).tilopay.attemptsById[key];
  const payment = (id = ORDER, patch = {}) => {
    const a = att(id);
    return { orderNumber: `${a.orderPrefix}-${a.orderNumber}`, merchantId: a.merchantId, id_tilopay: 7,
      type: "Payment", code: "1", currency: "CRC", amount: tp.formatAmountCRC(a.amount),
      environment: a.mode === "test" ? "Test" : "Production", capture: "Capture", ...patch };
  };
  return { ...mem, calls, bank, service, order, att, payment, advance: (ms) => { time += ms; } };
}

test("reserva atómica: importe, items y resumen provienen del catálogo", async () => {
  const h = harness();
  const result = await h.service.create(request());
  assert.equal(result.url, URL);
  assert.equal(result.crcTotal, 90000);
  assert.equal(h.calls.pay[0].amount, "90000.00");
  assert.notEqual(h.calls.pay[0].orderNumber, "VISIBLE-CLIENT-NUMBER-T1");
  assert.equal(h.att().snapshot.ownerUid, "user1");
  assert.equal(h.att().orderVersion, snapshotFingerprint(h.att().snapshot));
  assert.equal(h.order().itemsSummary[0].quantity, 2);
  assert.equal(h.order().itemsSummary[0].productName, "Eros");
  assert.equal(h.get(`orders/${ORDER}/items/item_0`).supplyType, "stock_propio");
  assert.equal(h.get("products/p1/variants/v1").reservedStock, 2);
  assert.equal(Object.keys(h.store).filter((p) => p.startsWith("tilopayReferences/")).length, 1);
});

test("la lectura transaccional detecta un item insertado antes de cerrar el pedido", async () => {
  const h = harness({ extra: {
    "products/p2": { name: "Otro", active: true, basePrice: 10000 },
    "products/p2/variants/v2": { price: 10000, stock: 10, supplyType: "stock_propio" },
  } });
  let inserted = false;
  h.db.beforeCommit = async ({ queryReads }) => {
    if (!inserted && queryReads.has(`orders/${ORDER}/items`)) {
      inserted = true;
      await h.set(`orders/${ORDER}/items/item_1`, { productId: "p2", variantId: "v2", quantity: 1, price: 1 });
    }
  };
  await h.service.create(request());
  assert.ok(h.stats.retries >= 1);
  assert.equal(h.calls.pay.length, 1);
  assert.equal(h.calls.pay[0].amount, "100000.00");
  assert.equal(h.att().snapshot.lines.length, 2);
});

test("dos Create simultáneos emiten una sola solicitud externa", async () => {
  const entered = deferred(); const reply = deferred();
  const h = harness({ onPay: async () => { entered.resolve(); return reply.promise; } });
  const first = h.service.create(request());
  await entered.promise;
  const second = await h.service.create(request());
  assert.equal(second.result, "pending");
  assert.equal(h.calls.pay.length, 1);
  reply.resolve(response({ type: "100", url: URL }));
  assert.equal((await first).url, URL);
  assert.equal(h.get("products/p1/variants/v1").reservedStock, 2);
});

test("cambio de precio, modo o plazo local no abandona un intento en vuelo", async () => {
  const entered = deferred(); const reply = deferred();
  const h = harness({ onPay: async () => { entered.resolve(); return reply.promise; } });
  const first = h.service.create(request()); await entered.promise;
  await h.db.doc("products/p1/variants/v1").update({ price: 50000 });
  h.advance(2 * 60 * 60 * 1000);
  const second = await h.service.create(request());
  assert.equal(second.result, "pending"); assert.equal(h.calls.pay.length, 1);
  assert.equal(h.att().status, "reserved"); assert.equal(h.att().amount, 90000);
  reply.resolve(response({ type: "100", url: URL })); await first;
  assert.equal((await h.service.create(request())).reused, true);
  assert.equal(h.calls.pay.length, 1);
});

test("timeout, HTTP 500 y JSON inválido jamás habilitan T2", async () => {
  for (const onPay of [async () => { throw new Error("timeout"); },
    async () => response({ type: "500" }, false, 500),
    async () => ({ ok: true, status: 200, data: null, jsonValid: false })]) {
    const h = harness({ onPay });
    assert.equal((await h.service.create(request())).result, "review");
    h.advance(86400000);
    assert.equal((await h.service.create(request())).result, "review");
    assert.equal(h.calls.pay.length, 1);
    assert.equal(h.att().status, "pending_reconciliation");
  }
});

test("otro pedido del mismo carrito apunta al original sin segundo cobro", async () => {
  const h = harness(); await h.service.create(request());
  const id = "OtherOrder12345678";
  await h.set(`orders/${id}`, orderData());
  await h.set(`orders/${id}/items/item_0`, { productId: "p1", variantId: "v1", quantity: 2 });
  const result = await h.service.create(request(id));
  assert.equal(result.orderId, ORDER); assert.equal(result.result, "pending");
  assert.equal(h.calls.pay.length, 1);
  assert.equal(h.order(id).tilopay, undefined);
});

test("lock de checkout permanece al cambiar test a live con pago incierto", async () => {
  const h = harness({ mode: "test" }); await h.service.create(request());
  await h.db.doc("config/payments").update({ tilopay: { enabled: true, mode: "live", merchantId: MERCHANT, orderPrefix: PREFIX } });
  const id = "OtherOrder12345678";
  await h.set(`orders/${id}`, orderData());
  await h.set(`orders/${id}/items/item_0`, { productId: "p1", variantId: "v1", quantity: 2 });
  assert.equal((await h.service.create(request(id))).orderId, ORDER);
  assert.equal(h.calls.pay.length, 1);
});

test("test exige rol, no reserva inventario ni marca el negocio pagado", async () => {
  const denied = harness({ mode: "test", extra: { "users_roles/user1": { role: "cliente" } } });
  await assert.rejects(denied.service.create(request()), { code: "permission-denied" });
  const h = harness({ mode: "test" }); await h.service.create(request());
  h.bank.set(h.att().orderNumber, [h.payment()]);
  assert.equal((await h.service.confirm(request())).result, "test_paid");
  assert.equal(h.order().paymentStatus, "test_paid"); assert.equal(h.order().status, "pendiente_pago");
  assert.equal(h.get("products/p1/variants/v1").reservedStock, 0);
  assert.equal(h.order().inventoryReservation, undefined);
});

test("Authorize nunca acredita; una captura posterior sí puede conciliarse", async () => {
  const h = harness(); await h.service.create(request());
  h.bank.set(h.att().orderNumber, [h.payment(ORDER, { capture: "Authorize" })]);
  assert.equal((await h.service.confirm(request())).result, "review");
  assert.notEqual(h.order().paymentStatus, "pagado");
  h.bank.set(h.att().orderNumber, [h.payment()]);
  assert.equal((await h.service.confirm(request())).result, "paid");
  assert.equal(h.order().paymentAmount, 90000);
});

test("una respuesta capturada posterior a decline no se descarta", async () => {
  const earlier = deferred(); const entered = deferred(); let calls = 0; let row;
  const h = harness({ onConsult: async () => {
    if (++calls === 1) { entered.resolve(); return earlier.promise; }
    return response({ type: "200", response: [{ ...row, code: "0" }] });
  } });
  await h.service.create(request()); row = h.payment();
  const first = h.service.confirm(request()); await entered.promise;
  assert.equal((await h.service.confirm(request())).result, "declined");
  earlier.resolve(response({ type: "200", response: [row] }));
  assert.equal((await first).result, "paid");
  assert.equal(h.order().paymentStatus, "pagado");
});

test("rechazo tardío no degrada un pago; Confirm repetido sigue consultando", async () => {
  const earlier = deferred(); const entered = deferred(); let calls = 0; let row;
  const h = harness({ onConsult: async () => {
    if (++calls === 1) { entered.resolve(); return earlier.promise; }
    return response({ type: "200", response: [row] });
  } });
  await h.service.create(request()); row = h.payment();
  const first = h.service.confirm(request()); await entered.promise;
  assert.equal((await h.service.confirm(request())).result, "paid");
  earlier.resolve(response({ type: "200", response: [{ ...row, code: "0" }] })); await first;
  assert.equal(h.order().paymentStatus, "pagado"); assert.equal(h.att().status, "approved");
  await h.service.confirm(request()); assert.equal(h.calls.consult.length, 3);
});

test("Authorize tardío no cambia identidad, captura ni ledger acreditado", async () => {
  const h = harness(); await h.service.create(request());
  h.bank.set(h.att().orderNumber, [h.payment()]); await h.service.confirm(request());
  h.bank.set(h.att().orderNumber, [h.payment(ORDER, { capture: "Authorize" })]);
  await h.service.confirm(request());
  assert.equal(h.att().status, "approved"); assert.equal(h.att().financialEvidence, "captured");
  assert.equal(h.att().capture, "Capture");
  assert.equal(Object.entries(h.store).find(([p]) => p.startsWith("tilopayTx/"))[1].state, "approved");
});

test("una transacción extra conserva la identidad principal y activa revisión", async () => {
  const h = harness(); await h.service.create(request());
  h.bank.set(h.att().orderNumber, [h.payment()]); await h.service.confirm(request());
  h.bank.set(h.att().orderNumber, [h.payment(ORDER, { id_tilopay: 8 })]);
  const result = await h.service.confirm(request());
  assert.equal(result.result, "review"); assert.equal(result.paid, true);
  assert.equal(h.order().paymentTransactionId, "7"); assert.equal(h.att().idTilopay, "7");
  assert.equal(h.att().financialEvidence, "captured"); assert.equal(h.order().tilopay.duplicatePaymentNeedsReview, true);
  assert.equal(Object.keys(h.store).filter((p) => p.startsWith("tilopayTx/")).length, 2);
});

test("modificación posterior no oculta revisión bajo already_paid", async () => {
  const h = harness(); await h.service.create(request());
  const row = h.payment(); h.bank.set(h.att().orderNumber, [row]); await h.service.confirm(request());
  h.bank.set(h.att().orderNumber, [row, { ...row, id_tilopay: 8, type: "Refund" }]);
  assert.equal((await h.service.confirm(request())).result, "review");
  assert.equal(h.att().financialEvidence, "captured");
  assert.equal(h.order().tilopay.reconciliationNeedsReview, true);
  assert.equal(Object.entries(h.store).find(([p]) => p.startsWith("tilopayCheckoutLocks/"))[1].state, "review");
});

test("confirmar un pago mientras processPayment vuelve no entrega otra URL", async () => {
  const entered = deferred(); const reply = deferred();
  const h = harness({ onPay: async () => { entered.resolve(); return reply.promise; } });
  const first = h.service.create(request()); await entered.promise;
  h.bank.set(h.att().orderNumber, [h.payment()]); await h.service.confirm(request());
  reply.resolve(response({ type: "100", url: URL }));
  const result = await first;
  assert.equal(result.result, "already_paid"); assert.equal(result.url, undefined);
  assert.equal(h.order().paymentStatus, "pagado");
});

test("cancelado con captura tardía conserva cancelación y registra revisión", async () => {
  const h = harness(); await h.service.create(request());
  await h.db.doc(`orders/${ORDER}`).update({ status: "cancelado" });
  h.bank.set(h.att().orderNumber, [h.payment()]);
  assert.equal((await h.service.confirm(request())).result, "review");
  assert.equal(h.order().status, "cancelado"); assert.notEqual(h.order().paymentStatus, "pagado");
  assert.equal(Object.entries(h.store).find(([p]) => p.startsWith("tilopayTx/"))[1].state, "needs_review");
});

test("mutación de total, subitems o dirección impide acreditar", async () => {
  for (const mutate of [
    (h) => h.db.doc(`orders/${ORDER}`).update({ total: 1000000 }),
    (h) => h.db.doc(`orders/${ORDER}/items/item_0`).update({ quantity: 20 }),
    (h) => h.db.doc(`orders/${ORDER}`).update({ shippingAddress: { ...h.order().shippingAddress, señas: "Otro destino" } }),
  ]) {
    const h = harness(); await h.service.create(request()); const row = h.payment(); await mutate(h);
    h.bank.set(h.att().orderNumber, [row]); assert.equal((await h.service.confirm(request())).result, "review");
    assert.notEqual(h.order().paymentStatus, "pagado"); assert.equal(h.order().paymentAmount, undefined);
  }
});

test("contexto del intento cambiado durante consult no acredita resultado viejo", async () => {
  const entered = deferred(); const reply = deferred();
  const h = harness({ mode: "test", onConsult: async () => { entered.resolve(); return reply.promise; } });
  await h.service.create(request()); const row = h.payment();
  const confirmation = h.service.confirm(request()); await entered.promise;
  const order = h.order(); order.tilopay.attemptsById.a1.mode = "live";
  await h.set(`orders/${ORDER}`, order);
  reply.resolve(response({ type: "200", response: [row] }));
  assert.equal((await confirmation).result, "review");
  assert.notEqual(h.order().paymentStatus, "pagado");
});

test("se consultan todos los intentos históricos, sin starvation después del quinto", async () => {
  const h = harness(); await h.service.create(request());
  const order = h.order();
  const original = h.att();
  for (let n = 2; n <= 6; n++) {
    const key = `a${n}`; const number = `AP-historicalreference${n}-T${n}`;
    order.tilopay.attemptsById[key] = { ...structuredClone(original), key, n, orderNumber: number };
    await h.set(`tilopayReferences/${snapshotFingerprint({ number })}`, { orderId: ORDER, attemptKey: key, ownerUid: "user1" });
  }
  await h.set(`orders/${ORDER}`, order);
  h.bank.set(original.orderNumber, [h.payment()]);
  assert.equal((await h.service.confirm(request())).result, "paid");
  assert.equal(h.calls.consult.length, 6);
  assert.equal(new Set(h.calls.consult.map((v) => v.orderNumber)).size, 6);
});

test("registro global impide aplicar un ID de transacción de otro pedido", async () => {
  const h = harness(); await h.service.create(request());
  const id = snapshotFingerprint({ merchantId: MERCHANT, mode: "live", id: "7" });
  await h.set(`tilopayTx/${id}`, { orderId: "SomeoneElseOrder", attemptKey: "a1", createdAt: "old" });
  h.bank.set(h.att().orderNumber, [h.payment()]);
  assert.equal((await h.service.confirm(request())).result, "review");
  assert.equal(h.get(`tilopayTx/${id}`).orderId, "SomeoneElseOrder");
  assert.notEqual(h.order().paymentStatus, "pagado");
});

test("legacy sin snapshot se concilia para revisión y nunca abre otro pago", async () => {
  const h = harness({ extra: { [`orders/${ORDER}`]: { ...orderData(),
    tilopay: { mode: "live", orderNumbers: ["OLD-T1"], crcTotal: 90000 } } } });
  const result = await h.service.create(request());
  assert.equal(result.result, "review"); assert.equal(h.calls.pay.length, 0);
  assert.equal(h.calls.consult[0].orderNumber, "OLD-T1");
});

test("propietario ajeno, alias contradictorio, método distinto y configuración incompleta se rechazan", async () => {
  const h = harness();
  await assert.rejects(h.service.create(request(ORDER, "intruso")), { code: "permission-denied" });
  await h.db.doc(`orders/${ORDER}`).update({ customerUid: "intruso" });
  await assert.rejects(h.service.create(request()), { code: "permission-denied" });
  const paypal = harness({ extra: { [`orders/${ORDER}`]: { ...orderData(), paymentMethod: "paypal" } } });
  await assert.rejects(paypal.service.create(request()), { code: "failed-precondition" });
  const missing = harness({ extra: { "config/payments": { tilopay: { enabled: true, mode: "live" } } } });
  assert.equal((await missing.service.getConfig()).enabled, false);
  await assert.rejects(missing.service.create(request()), { code: "failed-precondition" });
});

test("stock insuficiente aborta todo antes de llamar al proveedor", async () => {
  const h = harness({ extra: { "products/p1/variants/v1": { price: 45000, stock: 1, reservedStock: 0, supplyType: "stock_propio" } } });
  await assert.rejects(h.service.create(request()), { code: "failed-precondition" });
  assert.equal(h.calls.pay.length, 0); assert.equal(h.order().tilopay, undefined);
  assert.equal(Object.keys(h.store).filter((p) => p.startsWith("tilopayReferences/")).length, 0);
});


test("una contradicción de integridad no se borra al restaurar el pedido", async () => {
  const h = harness(); await h.service.create(request());
  const originalTotal = h.order().total;
  h.bank.set(h.att().orderNumber, [h.payment()]);
  await h.db.doc(`orders/${ORDER}`).update({ total: originalTotal + 1 });
  assert.equal((await h.service.confirm(request())).result, "review");
  await h.db.doc(`orders/${ORDER}`).update({ total: originalTotal });
  assert.equal((await h.service.confirm(request())).result, "review");
  assert.notEqual(h.order().paymentStatus, "pagado");
  assert.equal(h.order().tilopay.reconciliationNeedsReview, true);
  assert.equal(h.get(`tilopayCheckoutLocks/${h.order().tilopay.checkoutLockId}`).state, "review");
});

test("reanudar no devuelve URL si se acredita entre consulta y lectura transaccional", async () => {
  const h = harness(); await h.service.create(request());
  // Simulate an independent confirmed update after confirm's commit, before resume commits its read.
  let injected = false;
  h.db.beforeCommit = async ({ reads: readSet, writes }) => {
    if (!injected && readSet.has(`orders/${ORDER}`) && writes.length === 0) {
      injected = true;
      const old = h.order();
      await h.db.doc(`orders/${ORDER}`).update({ paymentStatus: "pagado", status: "pagado",
        paymentAmount: 90000, paymentTransactionId: "7", tilopay: { ...old.tilopay,
          attemptsById: { a1: { ...old.tilopay.attemptsById.a1, status: "approved", idTilopay: "7" } } } });
    }
  };
  const result = await h.service.create(request());
  assert.equal(injected, true);
  assert.equal(result.result, "already_paid");
  assert.equal(result.url, undefined);
  assert.equal(h.calls.pay.length, 1);
});


test("config test mínima permite pagar de prueba sin merchantId/prefijo y sin efectos reales", async () => {
  const h = harness({ mode: "test", extra: {
    "config/payments": { tilopay: { enabled: true, mode: "test" } },
  } });
  assert.deepEqual(await h.service.getConfig(), { enabled: true, mode: "test" });
  assert.equal((await h.service.create(request())).url, URL);
  h.bank.set(h.att().orderNumber, [h.payment(ORDER, {
    orderNumber: `PFC777-${h.att().orderNumber}`, merchantId: undefined,
  })]);
  assert.equal((await h.service.confirm(request())).result, "test_paid");
  assert.equal(h.calls.consult[0].merchantId, undefined);
  assert.equal(h.order().paymentStatus, "test_paid");
  assert.equal(h.order().status, "pendiente_pago");
  assert.equal(h.order().inventoryReservation, undefined);
  assert.equal(h.get("products/p1/variants/v1").reservedStock, 0);
  assert.equal((await h.service.confirm(request())).result, "test_paid");
  assert.equal(Object.keys(h.store).filter((key) => key.startsWith("tilopayTx/")).length, 1);
});

test("test sin comercio sigue exigiendo rol; live requiere comercio Y prefijo", async () => {
  const denied = harness({ mode: "test", extra: {
    "config/payments": { tilopay: { enabled: true, mode: "test" } },
    "users_roles/user1": { role: "cliente" },
  } });
  await assert.rejects(denied.service.create(request()), { code: "permission-denied" });
  for (const config of [
    { enabled: true, mode: "live" },
    { enabled: true, mode: "live", merchantId: MERCHANT },
    { enabled: true, mode: "live", orderPrefix: PREFIX },
    { enabled: true, merchantId: MERCHANT, orderPrefix: PREFIX },
  ]) {
    const h = harness({ extra: { "config/payments": { tilopay: config } } });
    assert.equal((await h.service.getConfig()).enabled, false);
    await assert.rejects(h.service.create(request()), { code: "failed-precondition" });
    assert.equal(h.calls.pay.length, 0);
  }
});

test("reserva live normaliza reservedStock negativo histórico y conserva stock real", async () => {
  const h = harness({ extra: { "products/p1/variants/v1": {
    name: "100ml", price: 45000, stock: 100, reservedStock: -1, supplyType: "stock_propio",
  } } });
  assert.equal((await h.service.create(request())).url, URL);
  assert.equal(h.calls.pay.length, 1);
  assert.equal(h.get("products/p1/variants/v1").reservedStock, 2);
  assert.equal(h.get("products/p1/variants/v1").stock, 100);
});

const quoteRequest = (items = [{ productId: "p1", variantId: "v1", quantity: 2 }]) => ({
  auth: { uid: "user1" }, data: { items, canton: "Grecia", shippingType: "normal" },
});
const backorderFixture = () => ({
  "products/p1/variants/v1": { price: 32000, stock: 0, reservedStock: 0, supplyType: "bajo_pedido" },
  [`orders/${ORDER}/items/item_0`]: { productId: "p1", variantId: "v1", quantity: 1, price: 1, supplyType: "stock_propio" },
});

test("cotización solo lee catálogo: sin rol tester, credenciales, reserva ni creación externa", async () => {
  const h = harness({ extra: { "config/payments": { tilopay: { enabled: false, mode: "test" } },
    "users_roles/user1": { role: "cliente" } },
    credentials: () => { throw new Error("No leer secretos al cotizar"); } });
  const before = structuredClone(h.store);
  const quote = await h.service.getQuote(quoteRequest());
  assert.deepEqual(quote, { currency: "CRC", crcTotal: 90000, crcSubtotal: 90000, crcShipping: 0,
    crcPayNow: 90000, crcBalanceDue: 0, crcDepositTotal: 0, crcBackorderSubtotal: 0, hasBackorder: false });
  assert.deepEqual(h.store, before);
  assert.equal(h.calls.credentials, 0); assert.equal(h.calls.token, 0);
  assert.equal(h.calls.pay.length, 0); assert.equal(h.calls.consult.length, 0);
  await assert.rejects(h.service.getQuote({ data: quoteRequest().data }), { code: "unauthenticated" });
});

test("cotización y cobro coinciden con apartado SINPE/PayPal para stock, Bajo pedido y mixto", async () => {
  for (const scenario of [
    { bo: false, mixed: false, total: 32000, payNow: 32000, balance: 0 },
    { bo: true, mixed: false, total: 32000, payNow: 16000, balance: 16000 },
    { bo: true, mixed: true, total: 42000, payNow: 26000, balance: 16000 },
  ]) {
    const fixture = backorderFixture();
    fixture["products/p1/variants/v1"].supplyType = scenario.bo ? "bajo_pedido" : "stock_propio";
    fixture["products/p1/variants/v1"].stock = scenario.bo ? 0 : 20;
    const items = [{ productId: "p1", variantId: "v1", quantity: 1, price: 1, supplyType: "bajo_pedido" }];
    if (scenario.mixed) {
      fixture["products/p2"] = { active: true, name: "Disponible", basePrice: 10000 };
      fixture["products/p2/variants/v2"] = { price: 10000, stock: 5, reservedStock: 0, supplyType: "stock_propio" };
      fixture[`orders/${ORDER}/items/item_1`] = { productId: "p2", variantId: "v2", quantity: 1 };
      items.push({ productId: "p2", variantId: "v2", quantity: 1 });
    }
    const h = harness({ extra: fixture });
    const quote = await h.service.getQuote(quoteRequest(items));
    const created = await h.service.create({ ...request(), data: { orderId: ORDER, expectedQuote: quote } });
    assert.equal(quote.crcTotal, scenario.total);
    assert.equal(quote.crcPayNow, scenario.payNow);
    assert.equal(quote.crcBalanceDue, scenario.balance);
    assert.equal(created.crcTotal, scenario.total);
    assert.equal(created.crcPayNow, scenario.payNow);
    assert.equal(created.partial, scenario.balance > 0);
    assert.equal(h.calls.pay[0].amount, `${scenario.payNow}.00`);
    assert.equal(h.calls.pay[0].capture, "1");
    assert.equal(h.order().total, scenario.total);
    assert.equal(h.att().snapshot.version, 2);
    assert.equal(h.att().snapshot.paymentPlan.version, 1);
    assert.equal(h.att().snapshot.paymentPlan.depositPercent, 50);
    const shared = computeBackorder(h.att().snapshot.lines, 0);
    assert.equal(shared.payNowTotal, quote.crcPayNow);
    assert.equal(shared.balanceDue, quote.crcBalanceDue);
    assert.equal(shared.depositTotal, quote.crcDepositTotal);
  }
});

test("capture de apartado conserva total/saldo, marca las líneas y no permite otro cobro", async () => {
  const h = harness({ extra: { ...backorderFixture(),
    "products/p2": { active: true, name: "Perfume en stock", basePrice: 10000 },
    "products/p2/variants/v2": { price: 10000, stock: 5, reservedStock: 0, supplyType: "stock_propio" },
    [`orders/${ORDER}/items/item_1`]: { productId: "p2", variantId: "v2", quantity: 1 },
  } });
  await h.service.create(request());
  assert.equal(h.get("products/p2/variants/v2").reservedStock, 1);
  assert.equal(h.get("products/p1/variants/v1").reservedStock, 0);
  h.bank.set(h.att().orderNumber, [h.payment()]);
  const result = await h.service.confirm(request());
  assert.equal(result.result, "paid"); assert.equal(result.partial, true);
  assert.equal(result.crcTotal, 42000); assert.equal(result.crcPayNow, 26000); assert.equal(result.crcBalanceDue, 16000);
  assert.equal(h.order().paymentStatus, "parcial"); assert.equal(h.order().status, "pendiente_pago");
  assert.equal(h.order().paymentAmount, 26000); assert.equal(h.order().total, 42000);
  assert.equal(h.order().remainingTotal, 16000); assert.equal(h.order().depositStatus, "pagado");
  assert.equal(h.order().remainingStatus, "pendiente"); assert.equal(h.order().backorderDepositPaid, true);
  const bo = h.get(`orders/${ORDER}/items/item_0`); const stock = h.get(`orders/${ORDER}/items/item_1`);
  assert.equal(bo.depositAmount, 16000); assert.equal(bo.depositPaid, true); assert.equal(bo.remainingPaid, false);
  assert.equal(stock.depositAmount, 0); assert.equal(stock.depositPaid, false); assert.equal(stock.remainingPaid, true);
  const before = h.order().paymentDate;
  const results = await Promise.all([h.service.create(request()), h.service.confirm(request()), h.service.reconcile(ORDER)]);
  assert.ok(results.every((value) => value.result === "already_paid" && value.partial === true));
  assert.equal(h.calls.pay.length, 1); assert.equal(h.order().paymentDate, before);
  assert.equal(h.order().remainingTotal, 16000);
  assert.equal(Object.keys(h.store).filter((path) => path.startsWith("tilopayTx/")).length, 1);
});

test("expectedQuote alterado o incompleto se rechaza antes de token, reserva o cobro", async () => {
  for (const patch of [{ crcPayNow: 1 }, { crcTotal: 16000 }, { crcBalanceDue: 0 },
    { hasBackorder: false }, { crcShipping: "0 USD" }, { currency: "USD" }, { crcDepositTotal: undefined }]) {
    const h = harness({ extra: backorderFixture() });
    const quote = await h.service.getQuote(quoteRequest([{ productId: "p1", variantId: "v1", quantity: 1 }]));
    await assert.rejects(h.service.create({ ...request(), data: { orderId: ORDER, expectedQuote: { ...quote, ...patch } } }),
      { code: "failed-precondition" });
    assert.equal(h.calls.token, 0); assert.equal(h.calls.credentials, 0); assert.equal(h.calls.pay.length, 0);
    assert.equal(h.order().tilopay, undefined); assert.equal(h.get(`tilopayReconciliation/${ORDER}`), undefined);
  }
});

test("cambio de catálogo durante reserve invalida la cotización y aborta atómicamente", async () => {
  const h = harness();
  const quote = await h.service.getQuote(quoteRequest());
  let changed = false;
  h.db.beforeCommit = async ({ queryReads }) => {
    if (!changed && queryReads.has(`orders/${ORDER}/items`)) {
      changed = true;
      await h.db.doc("products/p1/variants/v1").update({ price: 46000 });
    }
  };
  await assert.rejects(h.service.create({ ...request(), data: { orderId: ORDER, expectedQuote: quote } }),
    { code: "failed-precondition", details: { quote: { ...quote, crcTotal: 92000, crcSubtotal: 92000, crcPayNow: 92000 } } });
  assert.ok(h.stats.retries >= 1); assert.equal(h.calls.pay.length, 0);
  assert.equal(h.order().tilopay, undefined); assert.equal(h.get("products/p1/variants/v1").reservedStock, 0);
  assert.equal(h.get(`tilopayReconciliation/${ORDER}`), undefined);
});

test("resume devuelve el plan fijado aunque después cambie el catálogo", async () => {
  const h = harness({ extra: backorderFixture() });
  await h.service.create(request());
  await h.db.doc("products/p1/variants/v1").update({ price: 100000, supplyType: "stock_propio", stock: 3 });
  const resumed = await h.service.create({ ...request(), data: { orderId: ORDER, expectedQuote: { crcPayNow: 100000 } } });
  assert.equal(resumed.reused, true); assert.equal(resumed.crcTotal, 32000);
  assert.equal(resumed.crcPayNow, 16000); assert.equal(resumed.crcBalanceDue, 16000);
  assert.equal(h.calls.pay.length, 1);
});

test("snapshot histórico v1 mantiene cobro completo de Bajo pedido sin recalcular 50%", async () => {
  const h = harness({ extra: backorderFixture() });
  await h.service.create(request());
  const order = h.order();
  const snapshot = makeSnapshot(order, h.att().snapshot.lines,
    { total: order.total, subtotal: order.subtotal, shippingCost: order.shippingCost }, { version: 1 });
  const attempt = { ...h.att(), snapshot, orderVersion: snapshotFingerprint(snapshot),
    amountMinor: snapshot.amountMinor, amount: snapshot.amountMinor / 100 };
  await h.db.doc(`orders/${ORDER}`).update({ tilopay: { ...order.tilopay, attemptsById: { a1: attempt } } });
  const resumed = await h.service.create(request());
  assert.equal(resumed.crcTotal, 32000); assert.equal(resumed.crcPayNow, 32000);
  assert.equal(resumed.crcBalanceDue, 0); assert.equal(resumed.partial, false);
  h.bank.set(attempt.orderNumber, [h.payment()]);
  const captured = await h.service.confirm(request());
  assert.equal(captured.result, "paid"); assert.equal(captured.partial, false);
  assert.equal(h.order().paymentStatus, "pagado"); assert.equal(h.order().paymentAmount, 32000);
  assert.equal(h.order().remainingTotal, 0); assert.equal(h.att().snapshot.version, 1);
  assert.equal(h.att().snapshot.paymentPlan, undefined);
});

test("plan v2 alterado no acredita aunque los totales falsos tengan una nueva huella", async () => {
  const h = harness({ extra: backorderFixture() });
  await h.service.create(request());
  const a = h.att();
  a.snapshot.paymentPlan.remainingMinor = 0;
  a.snapshot.paymentPlan.depositMinor = 3200000;
  a.snapshot.paymentPlan.amountMinor = 3200000;
  a.snapshot.amountMinor = a.amountMinor = 3200000; a.amount = 32000;
  a.orderVersion = snapshotFingerprint(a.snapshot);
  await h.db.doc(`orders/${ORDER}`).update({ "tilopay.attemptsById.a1": a });
  h.bank.set(a.orderNumber, [h.payment()]);
  assert.equal((await h.service.confirm(request())).result, "review");
  assert.notEqual(h.order().paymentStatus, "pagado"); assert.notEqual(h.order().paymentStatus, "parcial");
});

test("la cola LIVE y reconcile concilian captura sin retorno del navegador", async () => {
  const h = harness({ extra: backorderFixture() });
  await h.service.create(request());
  const queue = h.get(`tilopayReconciliation/${ORDER}`);
  assert.equal(queue.orderId, ORDER); assert.equal(queue.nextCheckAt, h.att().createdAt);
  // The caller never invokes confirm. Trusted reconciliation loads the owner
  // from the persisted order and remains valid while new checkouts are disabled.
  await h.db.doc("config/payments").update({ tilopay: { enabled: false, mode: "live" } });
  h.bank.set(h.att().orderNumber, [h.payment()]);
  const result = await h.service.reconcile(ORDER);
  assert.equal(result.result, "paid"); assert.equal(result.partial, true);
  assert.equal(h.order().paymentStatus, "parcial"); assert.equal(h.calls.pay.length, 1);
  assert.equal((await h.service.reconcile(ORDER)).result, "already_paid");
});

test("reconcile ignora TEST o pedidos sin intento sin leer credenciales", async () => {
  const empty = harness({ credentials: () => { throw new Error("No debe pedir credenciales"); } });
  assert.equal((await empty.service.reconcile(ORDER)).reason, "not_live");
  assert.equal((await empty.service.reconcile("MissingOrder")).reason, "not_live");
  assert.equal(empty.calls.credentials, 0);
  const h = harness({ mode: "test", extra: backorderFixture() });
  await h.service.create(request());
  assert.equal(h.get(`tilopayReconciliation/${ORDER}`), undefined);
  const before = h.calls.credentials;
  h.bank.set(h.att().orderNumber, [h.payment()]);
  assert.equal((await h.service.reconcile(ORDER)).result, "skipped");
  assert.equal(h.calls.credentials, before); assert.equal(h.calls.consult.length, 0);
  assert.notEqual(h.order().paymentStatus, "parcial");
});

test("reconcile con Authorize conserva saldo pendiente y nunca captura automáticamente", async () => {
  const h = harness({ extra: backorderFixture() }); await h.service.create(request());
  h.bank.set(h.att().orderNumber, [h.payment(ORDER, { capture: "Authorize" })]);
  const result = await h.service.reconcile(ORDER);
  assert.equal(result.result, "review"); assert.equal(result.code, "pending_capture");
  assert.equal(h.order().depositStatus, "pendiente"); assert.notEqual(h.order().paymentStatus, "parcial");
  assert.equal(h.calls.pay.length, 1); assert.equal(h.calls.consult.length, 1);
});

test("deadline de conciliación no lanza consult tardíos ni acredita intentos omitidos", async () => {
  const h = harness(); await h.service.create(request());
  h.bank.set(h.att().orderNumber, [h.payment()]);
  const result = await h.service.reconcile(ORDER, { deadline: Date.UTC(2026, 9, 29, 10) + 10000 });
  assert.equal(result.result, "review"); assert.equal(h.calls.consult.length, 0);
  assert.notEqual(h.order().paymentStatus, "pagado");
  assert.equal((await h.service.reconcile(ORDER)).result, "paid");
});

test("reconcile no aplica un resultado si la historia cambia de LIVE a TEST durante consult", async () => {
  let row;
  const h = harness({ onConsult: async (_body, mem) => {
    const order = mem.get(`orders/${ORDER}`);
    await mem.db.doc(`orders/${ORDER}`).update({ tilopay: { ...order.tilopay, mode: "test",
      attemptsById: { a1: { ...order.tilopay.attemptsById.a1, mode: "test" } } } });
    return response({ type: "200", response: [row] });
  } });
  await h.service.create(request()); row = h.payment();
  const result = await h.service.reconcile(ORDER);
  assert.equal(result.result, "skipped"); assert.equal(result.reason, "not_live");
  assert.notEqual(h.order().paymentStatus, "pagado");
  assert.equal(Object.keys(h.store).filter((path) => path.startsWith("tilopayTx/")).length, 0);
});

const transientConsultFailures = [
  { name: "timeout", reply: () => { throw new Error("consult timeout"); } },
  { name: "HTTP 503", reply: () => response({ type: "503", message: "Servicio temporalmente no disponible" }, false, 503) },
  { name: "JSON inválido", reply: () => ({ ok: true, status: 200, data: null, jsonValid: false }) },
];
const verifyVia = (h, caller) => caller === "confirm" ? h.service.confirm(request()) : h.service.reconcile(ORDER);
const financialEvidence = (a) => Object.fromEntries([
  "status", "idTilopay", "financialEvidence", "capture", "validatedAmount", "validatedAmountMinor",
  "orderNumber", "returnedOrderNumber", "environment", "confirmedAt", "orderVersion", "snapshot",
].map((key) => [key, a[key]]));

test("captura confirmada sobrevive timeout/HTTP/JSON en confirm y reconcile y se recupera sin revisión permanente", async () => {
  for (const caller of ["confirm", "reconcile"]) for (const failure of transientConsultFailures) {
    for (const partial of [false, true]) {
      let row; let outage = false;
      const h = harness({ extra: partial ? backorderFixture() : {},
        onConsult: async () => outage ? failure.reply() : response({ type: "200", response: [row] }) });
      await h.service.create(request()); row = h.payment();
      assert.equal((await verifyVia(h, caller)).result, "paid");
      if (!partial) await h.db.doc(`orders/${ORDER}`).update({ status: "por_preparar" });
      const before = h.order(); const evidence = financialEvidence(h.att());
      const ledgerPaths = Object.keys(h.store).filter((path) => path.startsWith("tilopayTx/"));
      const ledgerBefore = ledgerPaths.map((path) => h.get(path));
      outage = true; h.advance(86400000);
      const unavailable = await verifyVia(h, caller);
      assert.equal(unavailable.result, "review", failure.name);
      assert.equal(unavailable.code, "pending_reconciliation"); assert.equal(unavailable.transient, true);
      assert.equal(unavailable.paid, true); assert.equal(unavailable.partial, partial);
      for (const key of ["status", "paymentStatus", "paymentAmount", "paymentTransactionId", "paymentDate", "remainingTotal", "depositStatus"]) {
        assert.deepEqual(h.order()[key], before[key], `${failure.name}: ${key}`);
      }
      assert.deepEqual(financialEvidence(h.att()), evidence);
      assert.deepEqual(ledgerPaths.map((path) => h.get(path)), ledgerBefore);
      assert.notEqual(h.order().tilopay.reconciliationNeedsReview, true);
      assert.notEqual(h.att().reconciliationNeedsReview, true);
      assert.equal(h.att().lastObservationTransient, true);
      assert.equal(h.get(`tilopayCheckoutLocks/${h.order().tilopay.checkoutLockId}`).state, "paid");
      outage = false; h.advance(60000);
      const recovered = await verifyVia(h, caller);
      assert.equal(recovered.result, "already_paid"); assert.equal(recovered.transient, undefined);
      assert.notEqual(h.order().tilopay.reconciliationNeedsReview, true);
      assert.equal(h.att().lastObservationTransient, false);
      assert.equal(h.calls.pay.length, 1);
    }
  }
});

test("una consulta transitoria nunca acredita un intento pendiente ni abre un segundo cobro", async () => {
  for (const caller of ["confirm", "reconcile"]) for (const failure of transientConsultFailures) {
    let row; let outage = true;
    const h = harness({ onConsult: async () => outage ? failure.reply() : response({ type: "200", response: [row] }) });
    await h.service.create(request()); row = h.payment();
    const result = await verifyVia(h, caller);
    assert.equal(result.result, "review"); assert.equal(result.code, "pending_reconciliation");
    assert.equal(result.transient, true); assert.equal(result.paid, false);
    assert.notEqual(h.order().paymentStatus, "pagado"); assert.notEqual(h.order().paymentStatus, "parcial");
    assert.equal(h.att().financialEvidence, undefined);
    assert.equal(Object.keys(h.store).filter((path) => path.startsWith("tilopayTx/")).length, 0);
    assert.equal((await h.service.create(request())).result, "review");
    assert.equal(h.calls.pay.length, 1);
    outage = false;
    assert.equal((await verifyVia(h, caller)).result, "paid");
    assert.notEqual(h.order().tilopay.reconciliationNeedsReview, true);
  }
});

test("reembolso, mismatch y movimientos dentro de error HTTP conservan alertas reales tras una caída y recuperación", async () => {
  for (const corruptResponse of [
    (row) => response({ type: "200", response: [{ ...row, type: "Refund" }] }),
    (row) => response({ type: "200", response: [{ ...row, amount: "1.00" }] }),
    (row) => response({ type: "200", response: [{ ...row, merchantId: "otro-comercio" }] }),
    (row) => response({ type: "200", response: [{ ...row, type: "Refund" }] }, false, 503),
  ]) {
    let row; let reply;
    const h = harness({ onConsult: async () => reply ? reply() : response({ type: "200", response: [row] }) });
    await h.service.create(request()); row = h.payment(); await h.service.confirm(request());
    const evidence = financialEvidence(h.att());
    reply = () => corruptResponse(row);
    const review = await h.service.reconcile(ORDER);
    assert.equal(review.result, "review"); assert.notEqual(review.transient, true);
    assert.equal(h.order().tilopay.reconciliationNeedsReview, true);
    assert.equal(h.att().reconciliationNeedsReview, true);
    reply = transientConsultFailures[0].reply;
    const unavailable = await h.service.confirm(request());
    assert.equal(unavailable.result, "review"); assert.notEqual(unavailable.transient, true);
    assert.equal(h.order().tilopay.reconciliationNeedsReview, true);
    assert.equal(h.att().reconciliationNeedsReview, true);
    assert.deepEqual(financialEvidence(h.att()), evidence);
    reply = null;
    assert.equal((await h.service.reconcile(ORDER)).result, "review");
    assert.equal(h.order().tilopay.reconciliationNeedsReview, true);
    assert.equal(h.calls.pay.length, 1);
  }
});

test("una caída no oculta una mutación local del snapshot ya acreditado", async () => {
  let row; let outage = false;
  const h = harness({ onConsult: async () => outage ? transientConsultFailures[0].reply()
    : response({ type: "200", response: [row] }) });
  await h.service.create(request()); row = h.payment(); await h.service.confirm(request());
  const item = h.get(`orders/${ORDER}/items/item_0`);
  await h.db.doc(`orders/${ORDER}/items/item_0`).update({ quantity: 3 });
  outage = true;
  const review = await h.service.reconcile(ORDER);
  assert.equal(review.result, "review"); assert.notEqual(review.transient, true);
  assert.equal(h.order().tilopay.reconciliationNeedsReview, true);
  await h.set(`orders/${ORDER}/items/item_0`, item); outage = false;
  assert.equal((await h.service.confirm(request())).result, "review");
  assert.equal(h.order().tilopay.reconciliationNeedsReview, true);
});

test("flags previos duplicate/legacy/reconciliation no se borran ni se disfrazan como transitorios", async () => {
  for (const flag of ["duplicatePaymentNeedsReview", "legacyNeedsReview", "reconciliationNeedsReview"]) {
    let row; let outage = false;
    const h = harness({ onConsult: async () => outage ? transientConsultFailures[1].reply()
      : response({ type: "200", response: [row] }) });
    await h.service.create(request()); row = h.payment(); await h.service.confirm(request());
    await h.db.doc(`orders/${ORDER}`).update({ [`tilopay.${flag}`]: true });
    outage = true;
    const result = await h.service.reconcile(ORDER);
    assert.equal(result.result, "review"); assert.notEqual(result.transient, true);
    assert.equal(h.order().tilopay[flag], true);
    outage = false;
    assert.equal((await h.service.confirm(request())).result, "review");
    assert.equal(h.order().tilopay[flag], true);
  }
});

test("fixture Tilopay inactivo reproduce 400 con motivo; activo cotiza ₡1000 sin cobrar", async () => {
  const productPath = "products/zz-tilopay-test";
  const h = harness({ mode: "test", extra: {
    [productPath]: { active: false, deleted: false, unlisted: true, basePrice: 1000, name: "ZZ Prueba Tilopay (no vender)" },
    [`${productPath}/variants/v1`]: { active: true, name: "Unico", price: 1000, stock: 1, reservedStock: 0 },
  } });
  const input = quoteRequest([{ productId: "zz-tilopay-test", variantId: "v1", quantity: 1 }]);
  await assert.rejects(h.service.getQuote(input), {
    code: "invalid-argument", details: { reason: "CATALOG_UNAVAILABLE", lineIndex: 0 },
  });
  assert.deepEqual(h.calls.quoteErrors, [{ severity: "WARNING", event: "tilopay_quote_rejected",
    reason: "CATALOG_UNAVAILABLE", lineIndex: 0, itemCount: 1 }]);
  await h.db.doc(productPath).update({ active: true });
  const before = structuredClone(h.store);
  const quote = await h.service.getQuote(input);
  assert.equal(quote.crcTotal, 1000);
  assert.equal(quote.crcPayNow, 1000);
  assert.equal(quote.crcShipping, 0);
  assert.equal(quote.crcBalanceDue, 0);
  assert.equal(h.get(productPath).unlisted, true);
  assert.equal(h.get("config/payments").tilopay.mode, "test");
  assert.deepEqual(h.store, before);
  assert.equal(h.calls.token, 0); assert.equal(h.calls.pay.length, 0);
});

test("rechazos de cotización registran códigos y posición sin volcar datos del cliente", async () => {
  const cases = [
    [{ items: [] }, "INVALID_ITEM_COUNT", undefined],
    [{ items: [{ productId: "p1", variantId: "v1", quantity: "1" }] }, "INVALID_ITEM", 0],
    [{ shippingType: "secreto-cliente" }, "INVALID_SHIPPING_TYPE", undefined],
    [{ canton: { secret: "secreto-cliente" } }, "INVALID_CANTON", undefined],
  ];
  for (const [data, reason, lineIndex] of cases) {
    const h = harness();
    const input = quoteRequest(); Object.assign(input.data, data, { token: "secreto-cliente" });
    await assert.rejects(h.service.getQuote(input), { code: "invalid-argument" });
    assert.equal(h.calls.quoteErrors[0].reason, reason);
    assert.equal(h.calls.quoteErrors[0].lineIndex, lineIndex);
    assert.doesNotMatch(JSON.stringify(h.calls.quoteErrors), /secreto-cliente|user1/);
    assert.equal(h.calls.pay.length, 0);
  }
});

test("fallo de infraestructura no se atribuye al cliente ni expone su mensaje", async () => {
  const events = [];
  const service = createTilopayService({ db: {}, HttpsError, onQuoteError: e => events.push(e),
    computeTotalsCRC: async () => { throw new Error("internal secret host details"); } });
  await assert.rejects(service.getQuote(quoteRequest()), { code: "internal", details: { reason: "QUOTE_INTERNAL_ERROR" } });
  assert.deepEqual(events, [{ severity: "ERROR", event: "tilopay_quote_rejected", reason: "QUOTE_INTERNAL_ERROR", itemCount: 1 }]);
});
