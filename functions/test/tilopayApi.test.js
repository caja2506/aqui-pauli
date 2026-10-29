"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const tp = require("../lib/tilopayApi");

const REF = "AP-1234567890abcdef1234567890abcdef-T1";
const CHECK = { orderNumber: REF, amountMinor: 9000040, mode: "live", merchantId: "88803956", orderPrefix: "PFC031932" };
const row = (patch = {}) => ({
  orderNumber: REF, id_tilopay: 7, merchantId: "88803956", amount: "90000.40", currency: "CRC",
  environment: "Production", type: "Payment", code: "1", capture: "Capture", ...patch,
});
const envelope = (rows) => ({ type: "200", message: "", response: rows });
const interpret = (rows, options = {}) => tp.interpretConsult(envelope(rows), { ...CHECK, ...options });

test("consult: only validated captured payment is approved; IDs and money are canonical", () => {
  const result = interpret([row()]);
  assert.equal(result.state, "approved");
  assert.equal(result.env, "live");
  assert.equal(result.amountMinor, 9000040);
  assert.equal(result.tx.id_tilopay, "7");
  assert.equal(result.tx.amount, "90000.40");
  assert.equal(tp.interpretConsult({ type: 200, response: [row()] }, CHECK).state, "approved");
  assert.equal(interpret([row({ code: 1 })]).state, "approved");
  assert.equal(interpret([row()], { amountMinor: undefined, amount: 90000.4 }).state, "approved");
  assert.equal(interpret([row()], { amountMinor: undefined, crcTotal: 90000.4 }).state, "approved");
});

test("consult: Authorize stays pending; absent or unknown capture is unresolved", () => {
  assert.equal(interpret([row({ capture: "Authorize" })]).state, "pending_capture");
  assert.equal(interpret([row({ capture: "capture" })]).state, "approved");
  for (const capture of [undefined, null, "", "Authorized", "Hold", "Captured", 1, {}, true]) {
    assert.equal(interpret([row({ capture })]).state, "pending_reconciliation");
  }
});

test("consult: response errors and malformed rows never become absence or approval", () => {
  for (const data of [null, "bad", [], {}, { response: [] }, { response: [row()] },
    { type: "400", response: [row()] }, { type: "400", message: "Invalid merchant credentials", response: [] },
    { type: "400", message: "Merchant does not exist" }, { type: "400", message: `Order number: ${REF} does not exist` },
    { type: "200", response: [null, 1, "bad"] }, { type: "200", response: [row(), null] },
    { type: "200", error: "Unauthorized", response: [] }, { type: "200", message: "Server error", response: [row()] }]) {
    assert.equal(tp.interpretConsult(data, CHECK).state, "pending_reconciliation", JSON.stringify(data));
    assert.equal(tp.looksNotFound(data), false, JSON.stringify(data));
  }
  assert.equal(interpret([]).state, "not_found");
  assert.equal(tp.looksNotFound({ type: 200, response: [] }), true);
});

test("consult: identity is exact and uses only the configured merchant prefix", () => {
  assert.equal(interpret([row({ orderNumber: `PFC031932-${REF}` })]).state, "approved");
  for (const orderNumber of [`ZZ999-${REF}`, `PFC031933-${REF}`, `X${REF}`, `OTRO-${REF}`, `${REF}-suffix`, null, 7]) {
    assert.equal(interpret([row({ orderNumber })]).state, "pending_reconciliation");
  }
  assert.equal(interpret([row({ orderNumber: `PFC031932-${REF}` })], { orderPrefix: "" }).state, "pending_reconciliation");
  assert.equal(interpret([row({ orderNumber: `EVIL-${REF}` })], { returnedOrderNumber: `EVIL-${REF}` }).state, "pending_reconciliation");
  assert.equal(interpret([row({ merchantId: "999" })]).state, "mismatch");
  for (const merchantId of [undefined, "", null, {}, true]) {
    assert.equal(interpret([row({ merchantId })]).state, "pending_reconciliation");
    assert.equal(interpret([row()], { merchantId }).state, "pending_reconciliation");
  }
});

test("consult: no credit/retry inference from refunds, modifications or unknown types", () => {
  for (const type of ["Refund", "Reversal", "Capture", "Unknown", "", undefined, {}, true]) {
    assert.equal(interpret([row({ type })]).state, "pending_reconciliation");
    assert.equal(interpret([row(), row({ type, id_tilopay: 8 })]).state, "pending_reconciliation");
  }
  assert.equal(interpret([row({ code: "05", capture: undefined })]).state, "declined");
  for (const code of [undefined, "", " ", null, true, {}, []]) {
    assert.equal(interpret([row({ code })]).state, "pending_reconciliation");
  }
});

test("consult: contradictory rows do not depend on response ordering", () => {
  assert.equal(interpret([row(), row()]).state, "approved");
  assert.equal(interpret([row(), row({ id_tilopay: 8 })]).state, "mismatch");
  for (const rows of [[row(), row({ capture: "Authorize" })], [row({ capture: "Authorize" }), row()],
    [row(), row({ code: "05" })], [row({ code: "05" }), row()]]) {
    assert.equal(interpret(rows).state, "pending_reconciliation");
  }
  assert.equal(interpret([row(), row({ amount: "90000.41" })]).state, "mismatch");
});

test("consult: strict IDs, decimal strings and amount/currency checks", () => {
  for (const id_tilopay of [undefined, null, "", {}, [], true, "7/8", "7-8", "0", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(interpret([row({ id_tilopay })]).state, "pending_reconciliation");
  }
  assert.equal(interpret([row({ id_tilopay: "9007199254740993" })]).tx.id_tilopay, "9007199254740993");
  for (const amount of [undefined, null, 90000.4, {}, [], true, "90000.400", "9.00004e4", "Infinity", "NaN", ""]) {
    assert.equal(interpret([row({ amount })]).state, "pending_reconciliation");
  }
  assert.equal(interpret([row({ amount: "90000.39" })]).state, "mismatch");
  assert.equal(interpret([row({ currency: "USD" })]).state, "mismatch");
  assert.equal(interpret([row({ currency: undefined })]).state, "pending_reconciliation");
  for (const amountMinor of [0, -1, "9000040", 9000040.1, Infinity, NaN]) {
    assert.equal(interpret([row()], { amountMinor }).state, "pending_reconciliation");
  }
});

test("consult: only recognized environments and coherent attempt mode", () => {
  for (const environment of ["Test", "TEST"]) {
    assert.equal(interpret([row({ environment })], { mode: "test" }).state, "approved");
    assert.equal(interpret([row({ environment })]).state, "mismatch");
  }
  for (const environment of ["Prod", "PROD", "Production"]) {
    assert.equal(interpret([row({ environment })]).state, "approved");
    assert.equal(interpret([row({ environment })], { mode: "test" }).state, "mismatch");
  }
  for (const environment of [undefined, "", "real", "live", "sandbox", "testing", "prueba", true]) {
    assert.equal(interpret([row({ environment })]).state, "pending_reconciliation");
  }
  for (const mode of [undefined, null, "", "production", "unexpected"]) {
    assert.equal(interpret([row()], { mode }).state, "pending_reconciliation");
  }
});

test("payment payload: cents survive and capture is the documented string 1", () => {
  const payload = tp.buildProcessPayload({
    key: "secret", redirect: "https://aquipauli.com/tilopay/retorno/order", orderId: "order", orderNumber: REF,
    amountMinor: 9000040, order: { customerName: "Ana Rojas", customerEmail: "a@example.com", customerPhone: "8888-7777",
      shippingAddress: { provincia: "Alajuela", canton: "Grecia", codigoPostal: "20301", señas: "Casa verde" } },
  });
  assert.equal(payload.amount, "90000.40");
  assert.equal(payload.currency, "CRC");
  assert.equal(payload.capture, "1");
  assert.equal(payload.billToState, "CR-A");
  assert.equal(payload.hashVersion, "V2");
  assert.equal(Buffer.from(payload.returnData, "base64").toString(), "order");
  assert.equal(tp.formatAmountCRC(45000.4), "45000.40");
  assert.throws(() => tp.formatAmountCRC("45000.004"));
});

test("reference requires a server token and positive safe attempt number", () => {
  assert.equal(tp.tilopayReference("1234567890abcdef1234567890abcdef", 1), REF);
  for (const token of [undefined, "", "id with space", "../badpath", "!invalid!"]) assert.throws(() => tp.tilopayReference(token, 1));
  for (const number of [0, -1, "1", 1.5, Infinity]) assert.throws(() => tp.tilopayReference("1234567890abcdef", number));
});

test("payment URL rejects other origins, protocols, userinfo and unexpected ports", () => {
  assert.equal(tp.isValidPaymentUrl("https://secure.tilopay.com/htmls/order.html"), true);
  assert.equal(tp.isValidPaymentUrl("https://app.tilopay.com/payment"), true);
  for (const value of ["http://secure.tilopay.com/x", "https://secure.tilopay.com.evil.test/x", "https://evil.test/x",
    "https://user:pass@secure.tilopay.com/x", "https://secure.tilopay.com:8443/x", "javascript:alert(1)", "//secure.tilopay.com/x", null]) {
    assert.equal(tp.isValidPaymentUrl(value), false);
  }
});

test("tpFetch preserves malformed JSON as unknown and never hides it in an empty object", async () => {
  const response = await tp.tpFetch("/api/v1/consult", { body: { orderNumber: REF }, fetchFn: async () => ({
    ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); },
  }) });
  assert.equal(response.jsonValid, false);
  assert.equal(response.parseError, true);
  assert.equal(response.data, null);
  assert.equal(tp.interpretConsult(response.data, CHECK).state, "pending_reconciliation");
});

test("API token cache honors expiry and is scoped to credentials", async () => {
  tp.clearTokenCache();
  let count = 0;
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ access_token: `T${++count}`, expires_in: 86400 }) });
  assert.equal(await tp.getToken({ apiUser: "u", password: "p", fetchFn, now: 1000 }), "T1");
  assert.equal(await tp.getToken({ apiUser: "u", password: "p", fetchFn, now: 2000 }), "T1");
  assert.equal(await tp.getToken({ apiUser: "u", password: "new", fetchFn, now: 2000 }), "T2");
  tp.clearTokenCache();
  await assert.rejects(tp.getToken({ apiUser: "u", password: "p", fetchFn: async () => ({ ok: true, status: 200,
    json: async () => ({ access_token: "T", expires_in: "bad" }) }) }));
  tp.clearTokenCache();
});
