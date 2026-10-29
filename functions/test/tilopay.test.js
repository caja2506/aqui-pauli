// node --test functions/test
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const tp = require("../lib/tilopayApi");

// ---------- lib/tilopayApi ----------
const OID = "Ord1AbCdEfGh2345"; // id de documento (servidor)
const REF = (n) => tp.tilopayReference(OID, n);

test("formatAmountCRC: entero con 2 decimales y valida", () => {
  assert.equal(tp.formatAmountCRC(45000), "45000.00");
  assert.equal(tp.formatAmountCRC(45000.4), "45000.00");
  assert.throws(() => tp.formatAmountCRC(0));
  assert.throws(() => tp.formatAmountCRC("x"));
});


test("tilopayReference: sale del id del documento, sin 'ORD' de relleno", () => {
  assert.equal(tp.tilopayReference(OID, 2), `AP-${OID}-T2`);
  assert.throws(() => tp.tilopayReference("", 1));
  assert.throws(() => tp.tilopayReference(undefined, 1));
  assert.throws(() => tp.tilopayReference("a b!", 1));
  assert.throws(() => tp.tilopayReference(OID, 0));
});

test("orderVersion: cambia si cambia el total, el envío o las líneas; no depende del orden", () => {
  const o = { total: 90000, subtotal: 90000, shippingCost: 0, shippingType: "normal", shippingAddress: { canton: "Grecia" },
    itemsSummary: [{ productId: "p1", variantId: "v1", quantity: 2, price: 45000 }, { productId: "p2", variantId: "v2", quantity: 1, price: 10 }] };
  const v = tp.orderVersion(o);
  assert.equal(tp.orderVersion({ ...o, itemsSummary: [...o.itemsSummary].reverse(), updatedAt: "x", tilopay: { a: 1 } }), v);
  assert.notEqual(tp.orderVersion({ ...o, total: 90001 }), v);
  assert.notEqual(tp.orderVersion({ ...o, shippingAddress: { canton: "San José" } }), v);
  assert.notEqual(tp.orderVersion({ ...o, itemsSummary: [{ ...o.itemsSummary[0], quantity: 3 }, o.itemsSummary[1]] }), v);
});

test("buildProcessPayload: CRC, referencia única, redirect, campos requeridos", () => {
  const order = {
    orderNumber: "AP-261029-L6N3", customerName: "Carlos Jimenez Arias", customerEmail: "c@x.com",
    customerPhone: "8888-7777",
    shippingAddress: { provincia: "Alajuela", canton: "Grecia", distrito: "Grecia", codigoPostal: "20301", señas: "Casa verde" },
  };
  const on = REF(2);
  const p = tp.buildProcessPayload({ key: "K", redirect: "https://aquipauli.com/tilopay/retorno/o1", orderId: "o1", order, orderNumber: on, crcTotal: 90000 });
  assert.equal(p.currency, "CRC");
  assert.equal(p.amount, "90000.00");
  assert.equal(p.orderNumber, on);
  assert.equal(p.billToState, "CR-A");
  assert.equal(p.billToTelephone, "88887777");
  assert.equal(p.token_version, "v2");
  assert.equal(p.capture, "1");
  assert.equal(Buffer.from(p.returnData, "base64").toString(), "o1");
  for (const k of ["billToFirstName", "billToLastName", "billToAddress", "billToAddress2", "billToCity", "billToState",
    "billToZipPostCode", "billToCountry", "billToTelephone", "billToEmail", "platform", "subscription", "key", "redirect"]) {
    assert.ok(p[k] !== undefined && p[k] !== "", `falta ${k}`);
  }
});

test("splitName: nombres de 1, 2 y varias palabras", () => {
  assert.deepEqual(tp.splitName("Ana"), { first: "Ana", last: "-" });
  assert.deepEqual(tp.splitName("Carlos Jimenez"), { first: "Carlos", last: "Jimenez" });
  assert.deepEqual(tp.splitName(""), { first: "Cliente", last: "Aqui Pauli" });
});


const row = (o = {}) => ({
  orderNumber: REF(1), amount: "90000.00", currency: "CRC", code: "1", type: "Payment", environment: "Production",
  id_tilopay: 7, auth: "123", capture: "Capture", merchantId: "88803956", ...o,
});
const CK = { orderNumber: REF(1), amount: 90000, mode: "live" };
const st = (rows, extra = {}) => tp.interpretConsult({ type: "200", response: rows }, { ...CK, ...extra });

test("interpretConsult: aprobado exige Capture, code 1, CRC, monto del intento, id, entorno y tipo", () => {
  const ok = st([row()]);
  assert.equal(ok.state, "approved");
  assert.equal(ok.env, "live");
  assert.equal(st([row({ amount: "89999.00" })]).state, "mismatch");
  assert.equal(st([row({ currency: "USD" })]).state, "mismatch");
  assert.equal(st([row({ code: "0" })]).state, "declined");
  assert.equal(st([row({ type: "Refund" })]).state, "declined");
  // compara contra el monto del PROPIO intento
  assert.equal(st([row({ amount: "45000.00" })], { amount: 45000 }).state, "approved");
  assert.equal(st([row()], { amount: 45000 }).state, "mismatch");
});

test("interpretConsult: Authorize, vacío o desconocido → pending_capture (no pagado)", () => {
  for (const capture of ["Authorize", "Authorized", "", undefined, "Hold", "capturado?"]) {
    const r = st([row({ capture })]);
    assert.equal(r.state, "pending_capture", `capture=${capture}`);
  }
  assert.equal(st([row({ capture: "capture" })]).state, "approved");
});

test("interpretConsult: incompleto o ilegible → pending_reconciliation (no not_found)", () => {
  for (const patch of [{ type: undefined }, { id_tilopay: undefined }, { id_tilopay: "" }, { environment: undefined },
    { environment: "Staging" }, { currency: undefined }, { amount: undefined }, { amount: "abc" }, { code: undefined }]) {
    const r = st([row(patch)]);
    assert.equal(r.state, "pending_reconciliation", JSON.stringify(patch));
  }
  for (const data of [{}, null, "x", { type: "200" }, { response: "oops" }, { type: "500", message: "Server error" }]) {
    assert.equal(tp.interpretConsult(data, CK).state, "pending_reconciliation", JSON.stringify(data));
  }
  // filas de otra orden = respuesta rara, no "no existe"
  assert.equal(st([row({ orderNumber: "OTRO" })]).state, "pending_reconciliation");
});

test("interpretConsult: not_found solo cuando Tilopay dice claramente que no hay transacción", () => {
  assert.equal(st([]).state, "not_found");
  assert.equal(tp.interpretConsult({ type: "400", message: "Order number: X does not exist" }, CK).state, "not_found");
});

test("interpretConsult: merchantId, varias transacciones y coherencia de entorno", () => {
  assert.equal(st([row({ merchantId: "999" })], { merchantId: "88803956" }).state, "mismatch");
  assert.equal(st([row()], { merchantId: "88803956" }).state, "approved");
  assert.equal(st([row({ merchantId: undefined })], { merchantId: "88803956" }).state, "approved"); // solo si viene
  assert.equal(st([row()], { merchantId: "" }).state, "approved");
  assert.equal(st([row(), row({ id_tilopay: 8 })]).state, "mismatch");
  // test vs live
  assert.equal(st([row({ environment: "Test" })], { mode: "live" }).state, "mismatch");
  assert.equal(st([row({ environment: "Production" })], { mode: "test" }).state, "mismatch");
  const t = st([row({ environment: "Test" })], { mode: "test" });
  assert.equal(t.state, "approved");
  assert.equal(t.env, "test");
  for (const e of ["PROD", "Production", "prod"]) assert.equal(tp.classifyEnvironment(e), "live");
  for (const e of ["TEST", "Test"]) assert.equal(tp.classifyEnvironment(e), "test");
  assert.equal(tp.classifyEnvironment("???"), null);
});

test("interpretConsult: acepta el prefijo de comercio que Tilopay antepone (PFC031932-…) pero no sufijos arbitrarios", () => {
  const r = (n) => st([row({ orderNumber: n })]).state;
  assert.equal(r(`PFC031932-${REF(1)}`), "approved");
  assert.equal(r(`X${REF(1)}`), "pending_reconciliation");
  assert.equal(r(`OTRO-${REF(1)}`), "pending_reconciliation");
  assert.equal(r(`12-${REF(1)}`), "pending_reconciliation");
});

test("getToken: cachea y usa apiuser/password", async () => {
  tp.clearTokenCache();
  let calls = 0; let seen;
  const fetchFn = async (url, init) => { calls++; seen = { url, init }; return { ok: true, status: 200, json: async () => ({ access_token: "T1", expires_in: 86400 }) }; };
  assert.equal(await tp.getToken({ apiUser: "u", password: "p", fetchFn, now: 1000 }), "T1");
  assert.equal(await tp.getToken({ apiUser: "u", password: "p", fetchFn, now: 2000 }), "T1");
  assert.equal(calls, 1);
  assert.equal(seen.url, "https://app.tilopay.com/api/v1/login");
  assert.deepEqual(JSON.parse(seen.init.body), { apiuser: "u", password: "p" });
  tp.clearTokenCache();
  await assert.rejects(tp.getToken({ apiUser: "u", password: "p", fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) }));
});


// ---------- handlers (con firebase-functions y Firestore simulados) ----------
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function loadHandlers(data, fetchImpl, configOverrides = {}) {
  const origLoad = Module._load;
  const store = data;
  let chain = Promise.resolve(); // las transacciones se serializan, como al reintentar en Firestore
  const docRef = (p) => ({
    path: p,
    async get() { const v = store[p]; return { exists: v !== undefined, data: () => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))) }; },
    async set(o) { store[p] = JSON.parse(JSON.stringify(o)); },
    async update(u) { if (store[p] === undefined) throw new Error("update de doc inexistente " + p); store[p] = { ...store[p], ...JSON.parse(JSON.stringify(u)) }; },
    collection: (c) => ({
      doc: (id) => docRef(`${p}/${c}/${id}`),
      async get() {
        const pre = `${p}/${c}/`;
        return { docs: Object.keys(store).filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes("/")).map((k) => ({ data: () => store[k] })) };
      },
    }),
  });
  const db = {
    collection: (c) => ({ doc: (id) => docRef(`${c}/${id}`) }),
    runTransaction: (fn) => {
      const run = chain.then(async () => {
        let wrote = false;
        return fn({
          get: async (r) => { if (wrote) throw new Error("Firestore: lecturas después de escrituras en la transacción"); return r.get(); },
          update: (r, u) => { wrote = true; return r.update(u); },
          set: (r, o) => { wrote = true; return r.set(o); },
        });
      });
      chain = run.catch(() => {});
      return run;
    },
  };
  const secrets = { TILOPAY_API_USER: "user", TILOPAY_API_PASSWORD: "pw", TILOPAY_KEY: "KEY123", ...configOverrides };
  Module._load = function (req, parent, isMain) {
    if (req === "firebase-functions/v2/https") return { onCall: (_o, h) => h, HttpsError };
    if (req === "firebase-functions/params") {
      return {
        defineSecret: (n) => ({ value: () => secrets[n] }),
        defineString: (n, o) => ({ value: () => o?.default }),
      };
    }
    if (req === "./utils" && parent?.filename?.endsWith(path.join("functions", "tilopay.js"))) return { db };
    return origLoad.apply(this, arguments);
  };
  const origFetch = global.fetch;
  global.fetch = fetchImpl;
  delete require.cache[require.resolve("../tilopay.js")];
  tp.clearTokenCache();
  const mod = require("../tilopay.js");
  Module._load = origLoad;
  return { mod, store, restore: () => { global.fetch = origFetch; delete require.cache[require.resolve("../tilopay.js")]; } };
}

const jsonRes = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
const U1 = { auth: { uid: "u1" }, data: { orderId: OID } };
const PAY_URL = "https://secure.tilopay.com/htmls/abc.html";

const baseData = (extra = {}) => ({
  "config/payments": { tilopay: { enabled: true, mode: "live" } },
  "products/p1": { name: "Eros", active: true, basePrice: 50000 },
  "products/p1/variants/v1": { price: 45000, active: true },
  [`orders/${OID}`]: {
    uid: "u1", orderNumber: "AP-1", customerName: "Ana Perez", customerEmail: "a@b.com", customerPhone: "88887777",
    total: 1, subtotal: 1, shippingCost: 0, shippingType: "normal", paymentStatus: "pendiente", status: "pendiente_pago",
    itemsSummary: [{ productId: "p1", variantId: "v1", quantity: 2, price: 1 }],
    shippingAddress: { provincia: "Alajuela", canton: "Grecia", distrito: "Grecia", codigoPostal: "20301", señas: "x" },
  },
  [`orders/${OID}/items/i1`]: { productId: "p1", variantId: "v1", quantity: 2, price: 1 },
  ...extra,
});
const withMode = (mode, extra = {}) => baseData({ "config/payments": { tilopay: { enabled: true, mode } }, ...extra });
const TESTER = { "users_roles/u1": { role: "tester" } };

/** Router de fetch: login, processPayment, consult (con registro de llamadas). */
function router({ onPay, onConsult } = {}) {
  const calls = { pay: [], consult: [] };
  const fn = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url.endsWith("/login")) return jsonRes({ access_token: "TOK", expires_in: 86400 });
    if (url.endsWith("/processPayment")) {
      calls.pay.push(body);
      if (onPay) return onPay(body, calls);
      return jsonRes({ type: "100", url: PAY_URL });
    }
    if (url.endsWith("/consult")) {
      calls.consult.push(body);
      return jsonRes(onConsult ? onConsult(body, calls) : { type: "200", response: [] });
    }
    throw new Error("url inesperada " + url);
  };
  fn.calls = calls;
  return fn;
}
const consultRows = (rows) => () => ({ type: "200", response: rows });

const order = (store) => store[`orders/${OID}`];
const att = (store, k = "a1") => order(store).tilopay.attemptsById[k];
const noPagado = (o) => { assert.notEqual(o.paymentStatus, "pagado"); assert.notEqual(o.status, "pagado"); };

/** Crea el intento a1 con el flujo real y deja el pedido listo para confirmar. */
async function withCreatedAttempt(mode, extraData = {}, onConsult) {
  const fetchImpl = router({ onConsult });
  const h = loadHandlers(withMode(mode, mode === "test" ? { ...TESTER, ...extraData } : extraData), fetchImpl);
  await h.mod.tilopayCreatePayment(U1);
  return { ...h, fetchImpl };
}

test("tilopayGetConfig: apagado por defecto; sin modo explícito 'live' se trata como test", async () => {
  const { mod, restore } = loadHandlers({}, router());
  try { assert.deepEqual(await mod.tilopayGetConfig({}), { enabled: false, mode: "test" }); } finally { restore(); }
  const h2 = loadHandlers({ "config/payments": { tilopay: { enabled: true } } }, router());
  try { assert.deepEqual(await h2.mod.tilopayGetConfig({}), { enabled: true, mode: "test" }); } finally { h2.restore(); }
  const h3 = loadHandlers(withMode("live"), router());
  try { assert.deepEqual(await h3.mod.tilopayGetConfig({}), { enabled: true, mode: "live" }); } finally { h3.restore(); }
});

// ---------- create ----------
test("create: falla si está apagado, sin sesión o con pedido ajeno", async () => {
  const f = router();
  const a = loadHandlers(baseData({ "config/payments": { tilopay: { enabled: false } } }), f);
  try { await assert.rejects(a.mod.tilopayCreatePayment(U1), { code: "failed-precondition" }); } finally { a.restore(); }
  const b = loadHandlers(baseData(), f);
  try {
    await assert.rejects(b.mod.tilopayCreatePayment({ auth: { uid: "intruso" }, data: { orderId: OID } }), { code: "permission-denied" });
    await assert.rejects(b.mod.tilopayCreatePayment({ data: { orderId: OID } }), { code: "unauthenticated" });
    assert.equal(f.calls.pay.length, 0);
  } finally { b.restore(); }
});

test("create: en modo TEST solo admin/tester; los demás reciben permission-denied y no se llama a Tilopay", async () => {
  for (const roles of [{}, { "users_roles/u1": { role: "cliente" } }]) {
    const f = router();
    const h = loadHandlers(withMode("test", roles), f);
    try {
      await assert.rejects(h.mod.tilopayCreatePayment(U1), { code: "permission-denied" });
      assert.equal(f.calls.pay.length, 0);
      assert.equal(order(h.store).tilopay, undefined);
    } finally { h.restore(); }
  }
  for (const role of ["admin", "tester"]) {
    const h = loadHandlers(withMode("test", { "users_roles/u1": { role } }), router());
    try { assert.equal((await h.mod.tilopayCreatePayment(U1)).url, PAY_URL); } finally { h.restore(); }
  }
});

test("create (live): recalcula en servidor, ignora precio del cliente, RESERVA el intento antes de llamar a Tilopay", async () => {
  let reservedWhenCalled;
  let storeRef;
  const f = router({ onPay: (body) => { reservedWhenCalled = JSON.parse(JSON.stringify(att(storeRef))); return jsonRes({ type: "100", url: PAY_URL }); } });
  const h = loadHandlers(baseData(), f);
  storeRef = h.store;
  try {
    const res = await h.mod.tilopayCreatePayment({ auth: { uid: "u1" }, data: { orderId: OID, amount: 1 } });
    assert.equal(res.url, PAY_URL);
    assert.equal(res.crcTotal, 90000);
    const sent = f.calls.pay[0];
    assert.equal(sent.amount, "90000.00");
    assert.equal(sent.currency, "CRC");
    assert.equal(sent.key, "KEY123");
    assert.equal(sent.orderNumber, REF(1)); // derivado del id del documento, no del orderNumber del cliente
    assert.equal(sent.redirect, `https://aquipauli.com/tilopay/retorno/${OID}`);
    assert.equal(reservedWhenCalled.status, "reserved"); // ya estaba guardado en Firestore
    const o = order(h.store);
    assert.equal(o.total, 90000);
    assert.equal(o.priceCorrectedByServer.previousTotal, 1);
    const a = att(h.store);
    assert.deepEqual([a.status, a.amount, a.currency, a.mode, a.orderNumber, a.url], ["open", 90000, "CRC", "live", REF(1), PAY_URL]);
    assert.equal(a.orderVersion, tp.orderVersion(o));
    assert.equal(o.tilopay.attemptCount, 1);
    assert.equal(o.paymentStatus, "pendiente"); // no se marca pagado al crear
    assert.equal(o.status, "pendiente_pago");
  } finally { h.restore(); }
});

test("create: reutiliza el intento abierto (no crea T2 mientras T1 sigue sin resolver)", async () => {
  const f = router();
  const h = loadHandlers(baseData(), f);
  try {
    const r1 = await h.mod.tilopayCreatePayment(U1);
    const r2 = await h.mod.tilopayCreatePayment(U1);
    assert.equal(r2.url, r1.url);
    assert.equal(r2.reused, true);
    assert.equal(f.calls.pay.length, 1);
    assert.deepEqual(Object.keys(order(h.store).tilopay.attemptsById), ["a1"]);
  } finally { h.restore(); }
});

test("create: dos llamadas simultáneas → un solo processPayment (la reserva es transaccional)", async () => {
  const f = router({ onPay: async () => { await new Promise((r) => setTimeout(r, 30)); return jsonRes({ type: "100", url: PAY_URL }); } });
  const h = loadHandlers(baseData(), f);
  try {
    const out = await Promise.allSettled([h.mod.tilopayCreatePayment(U1), h.mod.tilopayCreatePayment(U1)]);
    assert.equal(f.calls.pay.length, 1);
    assert.equal(out.filter((o) => o.status === "fulfilled").length, 1);
    const bad = out.find((o) => o.status === "rejected");
    assert.equal(bad.reason.code, "aborted");
    assert.equal(order(h.store).tilopay.attemptCount, 1);
  } finally { h.restore(); }
});

test("create: si el pedido cambió, abre T2 con su propio monto/versión y marca T1 como reemplazado (sigue consultable)", async () => {
  const f = router();
  const h = loadHandlers(baseData(), f);
  try {
    await h.mod.tilopayCreatePayment(U1);
    h.store["products/p1/variants/v1"].price = 50000; // cambia el precio → otro total
    const r2 = await h.mod.tilopayCreatePayment(U1);
    assert.equal(r2.crcTotal, 100000);
    assert.equal(f.calls.pay.length, 2);
    assert.equal(f.calls.pay[1].orderNumber, REF(2));
    assert.equal(att(h.store, "a1").superseded, true);
    assert.equal(att(h.store, "a1").amount, 90000);
    assert.equal(att(h.store, "a2").amount, 100000);
    assert.notEqual(att(h.store, "a1").orderVersion, att(h.store, "a2").orderVersion);
  } finally { h.restore(); }
});

test("create: processPayment con error definitivo → create_failed; sin respuesta → queda reserved y bloquea unos segundos", async () => {
  const bad = router({ onPay: () => jsonRes({ type: "400", message: "x" }, false, 400) });
  const h = loadHandlers(baseData(), bad);
  try {
    await assert.rejects(h.mod.tilopayCreatePayment(U1), { code: "internal" });
    assert.equal(att(h.store).status, "create_failed");
    // sin bloqueo: se puede reintentar (T2)
    bad.calls.pay.length = 0;
    await assert.rejects(h.mod.tilopayCreatePayment(U1), { code: "internal" });
    assert.equal(att(h.store, "a2").orderNumber, REF(2));
  } finally { h.restore(); }

  const timeout = router({ onPay: () => { throw new Error("timeout"); } });
  const h2 = loadHandlers(baseData(), timeout);
  try {
    await assert.rejects(h2.mod.tilopayCreatePayment(U1), { code: "unavailable" });
    assert.equal(att(h2.store).status, "reserved");
    await assert.rejects(h2.mod.tilopayCreatePayment(U1), { code: "aborted" }); // no abre T2 a ciegas
    assert.equal(timeout.calls.pay.length, 1);
    // pasados 2 min se consulta T1 primero; si no existe, se abandona y se abre T2
    att(h2.store).createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    global.fetch = router({ onConsult: () => ({ type: "200", response: [] }) });
    const r = await h2.mod.tilopayCreatePayment(U1);
    assert.equal(r.url, PAY_URL);
    assert.equal(att(h2.store, "a1").status, "abandoned");
    assert.equal(att(h2.store, "a2").status, "open");
  } finally { h2.restore(); }
});

test("create: no abre otro intento si hay uno en revisión/pendiente de captura, ni en pedidos pagados", async () => {
  for (const status of ["pending_capture", "pending_reconciliation", "mismatch", "approved", "test_paid"]) {
    const f = router();
    const h = loadHandlers(baseData({
      [`orders/${OID}`]: { ...baseData()[`orders/${OID}`], total: 90000, tilopay: { attemptCount: 1, attemptsById: { a1: { n: 1, status, amount: 90000, mode: "live", orderNumber: REF(1) } } } },
    }), f);
    try {
      await assert.rejects(h.mod.tilopayCreatePayment(U1), { code: "failed-precondition" }, status);
      assert.equal(f.calls.pay.length, 0);
    } finally { h.restore(); }
  }
  for (const patch of [{ paymentStatus: "pagado" }, { status: "por_preparar" }, { paymentStatus: "test_paid" }]) {
    const h = loadHandlers(baseData({ [`orders/${OID}`]: { ...baseData()[`orders/${OID}`], ...patch } }), router());
    try { await assert.rejects(h.mod.tilopayCreatePayment(U1), { code: "failed-precondition" }); } finally { h.restore(); }
  }
});

// ---------- confirm (live) ----------
const CONFIRM = (h) => h.mod.tilopayConfirm(U1);
const liveRow = (o = {}) => row({ orderNumber: `PFC031932-${REF(1)}`, ...o });

test("confirm (live): Capture aprobado → pagado, con el monto VALIDADO, registro tilopayTx y referencia devuelta", async () => {
  const h = await withCreatedAttempt("live");
  try {
    global.fetch = router({ onConsult: consultRows([liveRow()]) });
    const res = await CONFIRM(h);
    assert.equal(res.result, "paid");
    const o = order(h.store);
    assert.equal(o.paymentStatus, "pagado");
    assert.equal(o.status, "pagado");
    assert.equal(o.paymentMethod, "tilopay");
    assert.equal(o.paymentAmount, 90000);
    assert.equal(o.paymentTransactionId, "7");
    assert.equal(att(h.store).status, "approved");
    assert.equal(att(h.store).validatedAmount, 90000);
    assert.equal(att(h.store).returnedOrderNumber, `PFC031932-${REF(1)}`);
    assert.equal(h.store["tilopayTx/live_7"].orderId, OID);
    // idempotente
    assert.equal((await CONFIRM(h)).result, "already_paid");
  } finally { h.restore(); }
});

test("confirm (live): Authorize / sin capture → review (pendiente_captura), NO pagado; luego Capture → pagado", async () => {
  for (const capture of ["Authorize", undefined, "raro"]) {
    const h = await withCreatedAttempt("live");
    try {
      global.fetch = router({ onConsult: consultRows([liveRow({ capture })]) });
      const res = await CONFIRM(h);
      assert.equal(res.result, "review");
      const o = order(h.store);
      noPagado(o);
      assert.equal(o.paymentStatus, "verificando");
      assert.equal(o.status, "revision_manual");
      assert.equal(att(h.store).status, "pending_capture");
      assert.equal(h.store["tilopayTx/live_7"].status, "pending_capture");
      // más tarde Tilopay captura
      global.fetch = router({ onConsult: consultRows([liveRow({ capture: "Capture" })]) });
      assert.equal((await CONFIRM(h)).result, "paid");
      assert.equal(order(h.store).paymentStatus, "pagado");
      assert.equal(order(h.store).paymentAmount, 90000);
    } finally { h.restore(); }
  }
});

test("confirm (live): respuesta incompleta o ilegible → review (reconciliación), no not_found ni pagado", async () => {
  for (const data of [consultRows([liveRow({ id_tilopay: undefined })]), consultRows([liveRow({ environment: "Rara" })]),
    consultRows([liveRow({ type: undefined })]), () => ({}), () => ({ type: "200", response: "x" })]) {
    const h = await withCreatedAttempt("live");
    try {
      global.fetch = router({ onConsult: data });
      assert.equal((await CONFIRM(h)).result, "review");
      noPagado(order(h.store));
      assert.equal(att(h.store).status, "pending_reconciliation");
    } finally { h.restore(); }
  }
});

test("confirm (live): sin transacción → not_found; rechazo → declined; ninguno cambia el pedido", async () => {
  for (const [rows, expected, attStatus] of [[[], "not_found", "open"], [[liveRow({ code: "0" })], "declined", "declined"]]) {
    const h = await withCreatedAttempt("live");
    try {
      global.fetch = router({ onConsult: consultRows(rows) });
      const res = await CONFIRM(h);
      assert.equal(res.result, expected);
      assert.equal(res.retry, true);
      assert.equal(order(h.store).paymentStatus, "pendiente");
      assert.equal(order(h.store).status, "pendiente_pago");
      assert.equal(att(h.store).status, attStatus);
    } finally { h.restore(); }
  }
});

test("confirm (live): monto distinto al del INTENTO → review; el pedido no se acredita", async () => {
  const h = await withCreatedAttempt("live");
  try {
    global.fetch = router({ onConsult: consultRows([liveRow({ amount: "10.00" })]) });
    assert.equal((await CONFIRM(h)).result, "review");
    noPagado(order(h.store));
    assert.equal(att(h.store).status, "mismatch");
    assert.match(att(h.store).reason, /Monto/);
  } finally { h.restore(); }
});

test("confirm (live): usa el monto del propio intento; si el pedido cambió después, se rechaza aunque el monto del intento coincida", async () => {
  const h = await withCreatedAttempt("live");
  try {
    order(h.store).total = 120000; // el pedido cambia tras iniciar el pago (monto del intento: 90000)
    global.fetch = router({ onConsult: consultRows([liveRow()]) });
    const res = await CONFIRM(h);
    assert.equal(res.result, "review");
    noPagado(order(h.store));
    assert.match(att(h.store).reason, /cambió/);
    assert.equal(h.store["tilopayTx/live_7"].status, "needs_review"); // la transacción queda reservada para este pedido
  } finally { h.restore(); }
});

test("confirm (live): transacción de PRUEBAS en modo live → review; merchantId distinto → review", async () => {
  const h = await withCreatedAttempt("live");
  try {
    global.fetch = router({ onConsult: consultRows([liveRow({ environment: "Test" })]) });
    assert.equal((await CONFIRM(h)).result, "review");
    noPagado(order(h.store));
  } finally { h.restore(); }
  const h2 = await withCreatedAttempt("live");
  try {
    h2.store["config/payments"].tilopay.merchantId = "88803956";
    const f = router({ onConsult: consultRows([liveRow({ merchantId: "111" })]) });
    global.fetch = f;
    assert.equal((await CONFIRM(h2)).result, "review");
    assert.equal(f.calls.consult[0].merchantId, "88803956"); // se envía el merchantId configurado
    noPagado(order(h2.store));
  } finally { h2.restore(); }
});

test("confirm: una transacción de Tilopay no puede acreditar dos pedidos (registro tilopayTx)", async () => {
  const h = await withCreatedAttempt("live");
  try {
    // otro pedido ya tiene registrada la transacción live_7
    h.store["tilopayTx/live_7"] = { orderId: "OtroPedido12345", attempt: "a1", status: "approved" };
    global.fetch = router({ onConsult: consultRows([liveRow()]) });
    assert.equal((await CONFIRM(h)).result, "review");
    noPagado(order(h.store));
    assert.match(att(h.store).reason, /ya está registrada/);
    assert.equal(h.store["tilopayTx/live_7"].orderId, "OtroPedido12345"); // no se pisa
  } finally { h.restore(); }
});

test("confirm: nunca baja de estado un pedido pagado (mismatch/declined/pending llegan tarde) y marca doble cobro", async () => {
  for (const rows of [[liveRow({ amount: "5.00" })], [liveRow({ code: "0" })], [liveRow({ capture: "Authorize" })], [liveRow({ environment: "Rara" })]]) {
    const h = await withCreatedAttempt("live");
    try {
      // el pedido se paga por otra vía justo mientras se consulta a Tilopay
      global.fetch = router({ onConsult: (b) => { Object.assign(order(h.store), { paymentStatus: "pagado", status: "pagado", paymentTransactionId: "SINPE1" }); return { type: "200", response: rows }; } });
      await CONFIRM(h);
      const o = order(h.store);
      assert.equal(o.paymentStatus, "pagado");
      assert.equal(o.status, "pagado");
      assert.equal(o.paymentTransactionId, "SINPE1");
      assert.notEqual(o.tilopay.status, "mismatch");
    } finally { h.restore(); }
  }
  // cobro Capture válido en un pedido que ya estaba pagado → se registra pero NO se pisa el pedido; se marca revisión de reembolso
  const h = await withCreatedAttempt("live");
  try {
    global.fetch = router({ onConsult: (b) => { Object.assign(order(h.store), { paymentStatus: "pagado", status: "por_preparar", paymentTransactionId: "SINPE1", paymentAmount: 90000 }); return { type: "200", response: [liveRow()] }; } });
    await CONFIRM(h);
    const o = order(h.store);
    assert.equal(o.status, "por_preparar");
    assert.equal(o.paymentTransactionId, "SINPE1");
    assert.equal(o.tilopay.duplicatePaymentNeedsReview, true);
  } finally { h.restore(); }
});

test("confirm (live): dos intentos cobrados → el más reciente paga; el del pedido viejo NO se acredita y queda marcado para revisar reembolso", async () => {
  const f = router();
  const h = loadHandlers(baseData(), f);
  try {
    await h.mod.tilopayCreatePayment(U1);
    h.store["products/p1/variants/v1"].price = 50000;
    await h.mod.tilopayCreatePayment(U1); // T2 por 100000
    global.fetch = router({ onConsult: (b) => ({ type: "200", response: [
      b.orderNumber === REF(2) ? row({ orderNumber: REF(2), amount: "100000.00", id_tilopay: 22 }) : row({ orderNumber: REF(1), id_tilopay: 11 })] }) });
    assert.equal((await CONFIRM(h)).result, "paid");
    const o = order(h.store);
    assert.equal(o.paymentAmount, 100000);
    assert.equal(o.paymentTransactionId, "22");
    assert.equal(att(h.store, "a1").status, "mismatch"); // T1 se cobró por la versión anterior del pedido
    assert.equal(o.paymentTransactionId, "22");
    assert.equal(o.tilopay.duplicatePaymentNeedsReview, true);
  } finally { h.restore(); }
});

test("confirm: pedido ajeno, sin sesión y sin pago iniciado", async () => {
  const h = loadHandlers(baseData(), router());
  try {
    await assert.rejects(h.mod.tilopayConfirm({ auth: { uid: "intruso" }, data: { orderId: OID } }), { code: "permission-denied" });
    await assert.rejects(h.mod.tilopayConfirm({ data: { orderId: OID } }), { code: "unauthenticated" });
    await assert.rejects(CONFIRM(h), { code: "failed-precondition" });
  } finally { h.restore(); }
});

// ---------- confirm (TEST) ----------
const testRow = (o = {}) => row({ orderNumber: `PFC031932-${REF(1)}`, environment: "Test", ...o });

test("confirm (TEST): aprobado → test_paid; JAMÁS paymentStatus/status 'pagado' (no dispara inventario, Telegram ni CRM)", async () => {
  const h = await withCreatedAttempt("test");
  try {
    global.fetch = router({ onConsult: consultRows([testRow()]) });
    const res = await CONFIRM(h);
    assert.equal(res.result, "test_paid");
    const o = order(h.store);
    noPagado(o);
    assert.equal(o.paymentStatus, "test_paid");
    assert.equal(o.status, "pendiente_pago"); // el estado del pedido no cambia → onOrderStatusChange no hace nada
    assert.equal(o.paymentAmount, undefined);
    assert.equal(att(h.store).status, "test_paid");
    assert.equal(h.store["tilopayTx/test_7"].status, "test_paid");
    assert.equal((await CONFIRM(h)).result, "test_paid");
    // un pedido test_paid no abre otro intento
    await assert.rejects(h.mod.tilopayCreatePayment(U1), { code: "failed-precondition" });
  } finally { h.restore(); }
});

test("confirm (TEST): Authorize/incompleto/rechazo no tocan paymentStatus ni status del pedido", async () => {
  for (const rows of [[testRow({ capture: "Authorize" })], [testRow({ id_tilopay: undefined })], [testRow({ code: "0" })], [testRow({ environment: "Production" })]]) {
    const h = await withCreatedAttempt("test");
    try {
      global.fetch = router({ onConsult: consultRows(rows) });
      await CONFIRM(h);
      const o = order(h.store);
      assert.equal(o.paymentStatus, "pendiente");
      assert.equal(o.status, "pendiente_pago");
    } finally { h.restore(); }
  }
});

test("confirm (TEST): solo admin/tester puede confirmar; un cliente normal no", async () => {
  const h = await withCreatedAttempt("test");
  try {
    global.fetch = router({ onConsult: consultRows([testRow()]) });
    delete h.store["users_roles/u1"];
    await assert.rejects(CONFIRM(h), { code: "permission-denied" });
    h.store["users_roles/u1"] = { role: "cliente" };
    await assert.rejects(CONFIRM(h), { code: "permission-denied" });
    noPagado(order(h.store));
    assert.equal(order(h.store).paymentStatus, "pendiente");
  } finally { h.restore(); }
});

test("confirm: el modo del INTENTO manda aunque la config cambie (intento de prueba + config 'live' ≠ pagado)", async () => {
  const h = await withCreatedAttempt("test");
  try {
    h.store["config/payments"].tilopay.mode = "live";
    global.fetch = router({ onConsult: consultRows([testRow()]) });
    assert.equal((await CONFIRM(h)).result, "test_paid");
    noPagado(order(h.store));
  } finally { h.restore(); }
});

// ---------- reglas de Firestore (revisión estática; el emulador necesita Java) ----------
test("firestore.rules: el cliente no puede escribir tilopay/pago/dueño en pedidos", () => {
  const rules = require("node:fs").readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8");
  const create = rules.slice(rules.indexOf("allow create: if isAdmin()\n        || (request.auth != null\n            && request.resource.data.uid"));
  for (const k of ["'tilopay'", "'paypal'", "'paymentAmount'", "'paymentTransactionId'", "'priceCorrectedByServer'", "customerUid"]) {
    assert.ok(create.slice(0, 900).includes(k), `create debe vetar ${k}`);
  }
  assert.match(rules, /hasOnly\(\['paymentProofUrl', 'paymentPhone', 'paymentStatus', 'updatedAt'\]\)/);
  assert.match(rules, /get\('paymentMethod', ''\) != 'tilopay'/);
  assert.match(rules, /!\('tilopay' in getAfter/);
  assert.ok(!/match \/tilopayTx/.test(rules), "tilopayTx no debe tener reglas de cliente");
});
