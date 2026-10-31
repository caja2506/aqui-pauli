"use strict";
// Temporary one-shot readiness check. Only login/consult on three existing test transactions.
// Writes only verified identity fields (mode stays test) and a private redacted audit record.
const REPORT_PATH = "_ops/tilopay-readiness-v2-20261030";
const PREFIX = "PFC031932";
const ORDERS = Object.freeze(["TPTEST-A-T1", "TPTEST-A-T2", "TPTEST-R-T1"]);
function fail(code) { const error = new Error(code); error.diagnosticCode = code; throw error; }
function extractIdentity(response, order) {
  if (!ORDERS.includes(order)) fail("ORDER_NOT_ALLOWED");
  const data = response && response.data;
  if (!response || !response.ok || response.jsonValid === false || !data
      || Number(data.type) !== 200 || data.error || !Array.isArray(data.response)
      || data.response.length === 0 || data.response.length > 20) fail("INVALID_CONSULT");
  return data.response.map(row => {
    if (!row || row.orderNumber !== PREFIX + "-" + order) fail("ORDER_MISMATCH");
    const merchantId = typeof row.merchantId === "string" ? row.merchantId
      : Number.isSafeInteger(row.merchantId) ? String(row.merchantId) : "";
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(merchantId)) fail("MISSING_MERCHANT");
    const id = typeof row.id_tilopay === "string" ? row.id_tilopay
      : Number.isSafeInteger(row.id_tilopay) ? String(row.id_tilopay) : "";
    if (!/^[1-9][0-9]*$/.test(id)) fail("MISSING_TRANSACTION_ID");
    if (String(row.environment).toLowerCase() !== "test") fail("NOT_A_TEST_TRANSACTION");
    return { orderNumber: row.orderNumber, merchantId, idTilopay: id, environment: "Test" };
  });
}
async function inspectAndSave({ db, api, credentials, projectId, now = () => new Date().toISOString() }) {
  if (projectId !== "aqui-pauli") return { status: "wrong_project" };
  const report = db.doc(REPORT_PATH);
  try { await report.create({ status: "running", startedAt: now(), orderPrefix: PREFIX }); }
  catch (error) {
    if (error.code === 6 || error.code === "already-exists") return { status: "already_checked" };
    throw error;
  }
  let phase = "read_config";
  try {
    const configRef = db.doc("config/payments");
    const initial = (await configRef.get()).data();
    if (initial?.tilopay?.mode !== "test") fail("CONFIG_NOT_TEST");
    phase = "api_login";
    const c = credentials();
    const token = await api.getToken({ apiUser: c.apiUser, password: c.password });
    if (typeof token !== "string" || !token) fail("NO_API_TOKEN");
    phase = "consult_tests";
    const transactions = [];
    for (const order of ORDERS) {
      const response = await api.tpFetch("/api/v1/consult", { token, body: { key: c.key, orderNumber: order } });
      transactions.push(...extractIdentity(response, order));
    }
    const merchants = [...new Set(transactions.map(tx => tx.merchantId))];
    if (merchants.length !== 1) fail("MERCHANT_CONFLICT");
    phase = "save_verified_identity";
    const result = { status: "confirmed", merchantId: merchants[0], orderPrefix: PREFIX,
      mode: "test", apiAuthenticated: true, checkedAt: now(), transactions };
    await db.runTransaction(async t => {
      const latest = (await t.get(configRef)).data();
      if (latest?.tilopay?.mode !== "test") fail("CONFIG_CHANGED");
      if (latest.tilopay.merchantId && latest.tilopay.merchantId !== result.merchantId) fail("EXISTING_MERCHANT_CONFLICT");
      if (latest.tilopay.orderPrefix && latest.tilopay.orderPrefix !== PREFIX) fail("EXISTING_PREFIX_CONFLICT");
      t.update(configRef, { "tilopay.merchantId": result.merchantId, "tilopay.orderPrefix": PREFIX, "tilopay.mode": "test" });
      t.set(report, result, { merge: true });
    });
    return { status: "confirmed" };
  } catch (error) {
    await report.set({ status: "needs_attention", phase,
      reasonCode: error.diagnosticCode || "REQUEST_FAILED", checkedAt: now() }, { merge: true });
    return { status: "needs_attention" };
  }
}
module.exports = { REPORT_PATH, ORDERS, extractIdentity, inspectAndSave };
