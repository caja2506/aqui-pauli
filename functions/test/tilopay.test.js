// node --test functions/test
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const tp = require("../lib/tilopayApi");

// ---------- lib/tilopayApi ----------
test("formatAmountCRC: entero con 2 decimales y valida", () => {
  assert.equal(tp.formatAmountCRC(45000), "45000.00");
  assert.equal(tp.formatAmountCRC(45000.4), "45000.00");
  assert.throws(() => tp.formatAmountCRC(0));
  assert.throws(() => tp.formatAmountCRC("x"));
});

test("buildProcessPayload: CRC, orderNumber único, redirect, campos requeridos", () => {
  const order = {
    orderNumber: "AP-261029-L6N3", customerName: "Carlos Jimenez Arias", customerEmail: "c@x.com",
    customerPhone: "8888-7777",
    shippingAddress: { provincia: "Alajuela", canton: "Grecia", distrito: "Grecia", codigoPostal: "20301", señas: "Casa verde" },
  };
  const on = tp.tilopayOrderNumber(order, 2);
  assert.equal(on, "AP-261029-L6N3-T2");
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

const row = (o = {}) => ({ orderNumber: "A-T1", amount: "90000.00", currency: "CRC", code: "1", type: "Payment", environment: "Prod", id_tilopay: 7, auth: "123", ...o });

test("interpretConsult: aprobado exige code 1, CRC y monto igual", () => {
  const ok = tp.interpretConsult({ response: [row()] }, { orderNumber: "A-T1", crcTotal: 90000, mode: "live" });
  assert.equal(ok.state, "approved");
  assert.equal(tp.interpretConsult({ response: [row({ amount: "89999.00" })] }, { orderNumber: "A-T1", crcTotal: 90000 }).state, "mismatch");
  assert.equal(tp.interpretConsult({ response: [row({ currency: "USD" })] }, { orderNumber: "A-T1", crcTotal: 90000 }).state, "mismatch");
  assert.equal(tp.interpretConsult({ response: [row({ code: "0" })] }, { orderNumber: "A-T1", crcTotal: 90000 }).state, "declined");
  assert.equal(tp.interpretConsult({ response: [row({ orderNumber: "OTRO" })] }, { orderNumber: "A-T1", crcTotal: 90000 }).state, "not_found");
  assert.equal(tp.interpretConsult({ response: [] }, { orderNumber: "A-T1", crcTotal: 90000 }).state, "not_found");
  assert.equal(tp.interpretConsult({}, { orderNumber: "A-T1", crcTotal: 90000 }).state, "not_found");
  // un reembolso no cuenta como pago aprobado
  assert.equal(tp.interpretConsult({ response: [row({ type: "Refund" })] }, { orderNumber: "A-T1", crcTotal: 90000 }).state, "declined");
});

test("interpretConsult: acepta el prefijo de comercio que Tilopay antepone (PFC031932-…) pero no sufijos arbitrarios", () => {
  const r = (n) => tp.interpretConsult({ response: [row({ orderNumber: n })] }, { orderNumber: "A-T1", crcTotal: 90000 }).state;
  assert.equal(r("PFC031932-A-T1"), "approved");
  assert.equal(r("XA-T1"), "not_found");
  assert.equal(r("OTRO-A-T1"), "not_found");
  assert.equal(r("12-A-T1"), "not_found");
});

test("interpretConsult: transacción de pruebas se rechaza en live y se acepta en test", () => {
  const t = row({ environment: "Test" });
  assert.equal(tp.interpretConsult({ response: [t] }, { orderNumber: "A-T1", crcTotal: 90000, mode: "live" }).state, "mismatch");
  const r = tp.interpretConsult({ response: [t] }, { orderNumber: "A-T1", crcTotal: 90000, mode: "test" });
  assert.equal(r.state, "approved");
  assert.equal(r.testMode, true);
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
  const docRef = (p) => ({
    async get() { const v = store[p]; return { exists: v !== undefined, data: () => v }; },
    async update(u) { store[p] = { ...store[p], ...u }; },
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
    runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, u) => r.update(u) }),
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

const baseData = (extra = {}) => ({
  "config/payments": { tilopay: { enabled: true, mode: "live" } },
  "products/p1": { name: "Eros", active: true, basePrice: 50000 },
  "products/p1/variants/v1": { price: 45000, active: true },
  "orders/o1": {
    uid: "u1", orderNumber: "AP-1", customerName: "Ana Perez", customerEmail: "a@b.com", customerPhone: "88887777",
    total: 1, subtotal: 1, shippingCost: 0, shippingType: "normal", paymentStatus: "pendiente",
    shippingAddress: { provincia: "Alajuela", canton: "Grecia", distrito: "Grecia", codigoPostal: "20301", señas: "x" },
  },
  "orders/o1/items/i1": { productId: "p1", variantId: "v1", quantity: 2, price: 1 },
  ...extra,
});

const jsonRes = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });

test("tilopayGetConfig: apagado por defecto", async () => {
  const { mod, restore } = loadHandlers({}, async () => jsonRes({}));
  try { assert.deepEqual(await mod.tilopayGetConfig({}), { enabled: false, mode: "live" }); } finally { restore(); }
});

test("tilopayCreatePayment: falla si está apagado", async () => {
  const { mod, restore } = loadHandlers(baseData({ "config/payments": { tilopay: { enabled: false } } }), async () => jsonRes({}));
  try {
    await assert.rejects(mod.tilopayCreatePayment({ auth: { uid: "u1" }, data: { orderId: "o1" } }), { code: "failed-precondition" });
  } finally { restore(); }
});

test("tilopayCreatePayment: recalcula en servidor (CRC), ignora precio del cliente, guarda intento", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/login")) return jsonRes({ access_token: "TOK", expires_in: 86400 });
    if (url.endsWith("/processPayment")) { sent = JSON.parse(init.body); return jsonRes({ type: "100", url: "https://pay.tilopay.test/abc" }); }
    throw new Error("url inesperada " + url);
  };
  const { mod, store, restore } = loadHandlers(baseData(), fetchImpl);
  try {
    const res = await mod.tilopayCreatePayment({ auth: { uid: "u1" }, data: { orderId: "o1", amount: 1 } });
    assert.equal(res.url, "https://pay.tilopay.test/abc");
    assert.equal(res.crcTotal, 90000);
    assert.equal(sent.amount, "90000.00");
    assert.equal(sent.currency, "CRC");
    assert.equal(sent.key, "KEY123");
    assert.equal(sent.orderNumber, "AP-1-T1");
    assert.equal(sent.redirect, "https://aquipauli.com/tilopay/retorno/o1");
    assert.equal(store["orders/o1"].total, 90000);
    assert.equal(store["orders/o1"].priceCorrectedByServer.previousTotal, 1);
    assert.deepEqual(store["orders/o1"].tilopay.orderNumbers, ["AP-1-T1"]);
    assert.equal(store["orders/o1"].paymentStatus, "pendiente"); // no se marca pagado al crear
  } finally { restore(); }
});

test("tilopayCreatePayment: otro usuario no puede pagar un pedido ajeno", async () => {
  const { mod, restore } = loadHandlers(baseData(), async () => jsonRes({}));
  try {
    await assert.rejects(mod.tilopayCreatePayment({ auth: { uid: "intruso" }, data: { orderId: "o1" } }), { code: "permission-denied" });
    await assert.rejects(mod.tilopayCreatePayment({ data: { orderId: "o1" } }), { code: "unauthenticated" });
  } finally { restore(); }
});

const withAttempt = (extra = {}) => baseData({
  "orders/o1": {
    ...baseData()["orders/o1"], total: 90000,
    tilopay: { mode: "live", attempts: 1, orderNumber: "AP-1-T1", orderNumbers: ["AP-1-T1"], currency: "CRC", crcTotal: 90000 },
    ...extra,
  },
});
const consultFetch = (rows) => async (url) => {
  if (url.endsWith("/login")) return jsonRes({ access_token: "TOK", expires_in: 86400 });
  if (url.endsWith("/consult")) return jsonRes({ type: "200", response: rows });
  throw new Error("url inesperada " + url);
};

test("tilopayConfirm: aprobado por consult → pedido pagado", async () => {
  const { mod, store, restore } = loadHandlers(withAttempt(), consultFetch([row({ orderNumber: "AP-1-T1" })]));
  try {
    const res = await mod.tilopayConfirm({ auth: { uid: "u1" }, data: { orderId: "o1" } });
    assert.equal(res.result, "paid");
    assert.equal(store["orders/o1"].paymentStatus, "pagado");
    assert.equal(store["orders/o1"].status, "pagado");
    assert.equal(store["orders/o1"].paymentMethod, "tilopay");
    assert.equal(store["orders/o1"].paymentAmount, 90000);
  } finally { restore(); }
});

test("tilopayConfirm: no marca pagado sin transacción, con rechazo ni con monto distinto", async () => {
  for (const [rows, expected, status] of [
    [[], "not_found", "pendiente"],
    [[row({ orderNumber: "AP-1-T1", code: "0" })], "declined", "pendiente"],
    [[row({ orderNumber: "AP-1-T1", amount: "10.00" })], "review", "verificando"],
    [[row({ orderNumber: "AP-1-T1", environment: "Test" })], "review", "verificando"],
  ]) {
    const { mod, store, restore } = loadHandlers(withAttempt(), consultFetch(rows));
    try {
      const res = await mod.tilopayConfirm({ auth: { uid: "u1" }, data: { orderId: "o1" } });
      assert.equal(res.result, expected);
      assert.notEqual(store["orders/o1"].paymentStatus, "pagado");
      assert.equal(store["orders/o1"].paymentStatus, status);
    } finally { restore(); }
  }
});

test("tilopayConfirm: encuentra pago de un intento anterior e idempotente si ya está pagado", async () => {
  const data = withAttempt({ tilopay: { mode: "live", attempts: 2, orderNumber: "AP-1-T2", orderNumbers: ["AP-1-T1", "AP-1-T2"], currency: "CRC", crcTotal: 90000 } });
  const { mod, store, restore } = loadHandlers(data, consultFetch([row({ orderNumber: "AP-1-T1" })]));
  try {
    assert.equal((await mod.tilopayConfirm({ auth: { uid: "u1" }, data: { orderId: "o1" } })).result, "paid");
    assert.equal(store["orders/o1"].tilopay.orderNumber, "AP-1-T1");
    assert.equal((await mod.tilopayConfirm({ auth: { uid: "u1" }, data: { orderId: "o1" } })).result, "already_paid");
  } finally { restore(); }
});

test("tilopayConfirm: pedido sin pago Tilopay iniciado", async () => {
  const { mod, restore } = loadHandlers(baseData(), consultFetch([]));
  try {
    await assert.rejects(mod.tilopayConfirm({ auth: { uid: "u1" }, data: { orderId: "o1" } }), { code: "failed-precondition" });
  } finally { restore(); }
});
