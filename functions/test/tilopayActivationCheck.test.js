"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { REPORT_PATH, ORDERS, extractIdentity, inspectAndSave } = require("../lib/tilopayActivationCheck");
function response(order, merchantId = "ACTUAL123") {
  return { ok: true, jsonValid: true, status: 200, data: { type: 200, response: [{
    orderNumber: "PFC031932-" + order, merchantId, id_tilopay: "6186928", environment: "Test",
    apiKey: "DO_NOT_DISCLOSE", email: "private@example.com", auth: "DO_NOT_DISCLOSE"
  }] } };
}
function fixture({ existing = false, currentMode = "test", changedMode } = {}) {
  let record = existing ? { status: "confirmed" } : null;
  let config = { tilopay: { enabled: true, mode: currentMode }, other: "keep" };
  let writes = 0;
  const report = { async create(v) { if (record) throw Object.assign(new Error("exists"), { code: 6 }); record = v; },
    async set(v) { record = { ...record, ...v }; } };
  const configRef = { async get() { return { data: () => config }; } };
  const db = { doc: path => path === REPORT_PATH ? report : configRef,
    async runTransaction(fn) {
      const pending = [];
      const t = { async get() { return { data: () => changedMode ? { ...config, tilopay: { ...config.tilopay, mode: changedMode } } : config }; },
        update(ref, values) { pending.push(() => { for (const [k,v] of Object.entries(values)) config.tilopay[k.split(".")[1]] = v; writes++; }); },
        set(ref, value) { pending.push(() => { record = { ...record, ...value }; }); } };
      await fn(t);
      pending.forEach(fn => fn());
    } };
  const calls = [];
  const api = { async getToken() { calls.push("login"); return "TOKEN_SECRET"; },
    async tpFetch(path, options) { calls.push({ path, order: options.body.orderNumber }); return response(options.body.orderNumber); } };
  return { db, api, credentials: () => ({ apiUser: "API_USER_SECRET", password: "PASSWORD_SECRET", key: "KEY_SECRET" }),
    projectId: "aqui-pauli", now: () => "2026-10-31T00:00:00.000Z",
    state: () => ({ record, config, writes, calls }) };
}
test("reads merchant from provider and excludes unrelated sensitive fields", () => {
  const result = extractIdentity(response(ORDERS[0], "DIFFERENT456"), ORDERS[0]);
  assert.equal(result[0].merchantId, "DIFFERENT456");
  assert.ok(!JSON.stringify(result).includes("DO_NOT_DISCLOSE"));
  assert.ok(!JSON.stringify(result).includes("private@"));
});
test("rejects unrelated orders, unknown merchants, real payments and empty responses", () => {
  for (const mutate of [
    r => r.data.response[0].orderNumber = "PFC031932-OTHER",
    r => r.data.response[0].merchantId = "",
    r => r.data.response[0].environment = "Live",
    r => r.data.response = []
  ]) { const r = response(ORDERS[0]); mutate(r); assert.throws(() => extractIdentity(r, ORDERS[0])); }
});
test("checks only allowed tests and saves identity while preserving test mode and other configuration", async () => {
  const f = fixture();
  assert.equal((await inspectAndSave(f)).status, "confirmed");
  const { record, config, writes, calls } = f.state();
  assert.equal(writes, 1);
  assert.deepEqual(config, { tilopay: { enabled: true, mode: "test", merchantId: "ACTUAL123", orderPrefix: "PFC031932" }, other: "keep" });
  assert.deepEqual(calls.slice(1), ORDERS.map(order => ({ path: "/api/v1/consult", order })));
  assert.ok(!JSON.stringify(record).includes("SECRET"));
});
test("conflicting merchants never modify configuration", async () => {
  const f = fixture();
  f.api.tpFetch = async (path, options) => response(options.body.orderNumber, options.body.orderNumber === ORDERS[0] ? "A" : "B");
  assert.equal((await inspectAndSave(f)).status, "needs_attention");
  assert.equal(f.state().writes, 0);
  assert.equal(f.state().record.reasonCode, "MERCHANT_CONFLICT");
});
test("does not repeat an existing check", async () => {
  const f = fixture({ existing: true });
  assert.equal((await inspectAndSave(f)).status, "already_checked");
  assert.equal(f.state().calls.length, 0);
});
test("does not overwrite a concurrent change to live", async () => {
  const f = fixture({ changedMode: "live" });
  assert.equal((await inspectAndSave(f)).status, "needs_attention");
  assert.equal(f.state().writes, 0);
  assert.equal(f.state().record.reasonCode, "CONFIG_CHANGED");
});
test("provider errors do not disclose their messages or credentials", async () => {
  const f = fixture();
  f.api.getToken = async () => { throw new Error("PASSWORD_SECRET"); };
  assert.equal((await inspectAndSave(f)).status, "needs_attention");
  assert.equal(f.state().writes, 0);
  assert.equal(f.state().record.reasonCode, "REQUEST_FAILED");
  assert.ok(!JSON.stringify(f.state().record).includes("SECRET"));
});
test("does not contact provider outside the requested project or test mode", async () => {
  const f = fixture({ currentMode: "live" });
  await inspectAndSave(f);
  assert.equal(f.state().calls.length, 0);
  const g = fixture(); g.projectId = "unrelated";
  assert.equal((await inspectAndSave(g)).status, "wrong_project");
  assert.equal(g.state().record, null);
});
