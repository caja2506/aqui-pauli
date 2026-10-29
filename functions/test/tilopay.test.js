"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const tp = require("../lib/tilopayApi");
const { createTilopayService } = require("../lib/tilopayService");
const { snapshotFingerprint } = require("../lib/tilopayOrder");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");

class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
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

function harness({ mode = "live", extra = {}, onPay, onConsult } = {}) {
  const mem = createMemoryFirestore({ ...seed(mode), ...extra });
  const calls = { pay: [], consult: [] };
  let nonce = 0;
  let time = Date.UTC(2026, 9, 29, 10);
  const bank = new Map();
  const api = { ...tp, getToken: async () => "TOKEN",
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
    credentials: () => ({ apiUser: "u", password: "p", key: KEY }), returnBase: () => "https://aquipauli.com",
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
