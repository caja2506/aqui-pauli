// ==============================================
// Cliente mínimo de la API de Tilopay (Hosted Payment Page). Sin dependencias.
// Docs: https://tilopay.com/developers  (openapi.json)
//   POST /api/v1/login          → token del API (24 h)
//   POST /api/v1/processPayment → URL del formulario de pago alojado
//   POST /api/v1/consult        → estado y monto de una transacción por orderNumber
// Pruebas y producción usan el MISMO host; el modo se cambia en el panel de Tilopay.
// ==============================================

const TILOPAY_BASE = "https://app.tilopay.com";

const PROVINCE_ISO = {
  "san josé": "CR-SJ", "san jose": "CR-SJ",
  alajuela: "CR-A", cartago: "CR-C", heredia: "CR-H",
  guanacaste: "CR-G", puntarenas: "CR-P", limón: "CR-L", limon: "CR-L",
};

let cachedToken = null; // { token, exp }

async function tpFetch(path, { token, body, fetchFn = fetch } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `bearer ${token}`;
  const res = await fetchFn(`${TILOPAY_BASE}${path}`, {
    method: "POST", headers, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Token del API; se cachea en memoria hasta 5 min antes de expirar. */
async function getToken({ apiUser, password, fetchFn = fetch, now = Date.now() }) {
  if (cachedToken && cachedToken.exp > now) return cachedToken.token;
  const res = await tpFetch("/api/v1/login", { body: { apiuser: apiUser, password }, fetchFn });
  const token = res.data?.access_token;
  if (!res.ok || !token) throw new Error(`Tilopay login ${res.status}`);
  const ttl = Number(res.data.expires_in) > 600 ? Number(res.data.expires_in) : 3600;
  cachedToken = { token, exp: now + (ttl - 300) * 1000 };
  return token;
}
function clearTokenCache() { cachedToken = null; }

/** Monto CRC como texto con 2 decimales ("45000.00"). */
function formatAmountCRC(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) throw new Error("Monto inválido");
  return v.toFixed(2);
}

const clean = (s, max = 100) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);

function splitName(full) {
  const parts = clean(full).split(" ").filter(Boolean);
  if (parts.length === 0) return { first: "Cliente", last: "Aqui Pauli" };
  if (parts.length === 1) return { first: parts[0], last: "-" };
  const mid = Math.ceil(parts.length / 2);
  return { first: parts.slice(0, mid).join(" "), last: parts.slice(mid).join(" ") };
}

/** Número de orden enviado a Tilopay: único por intento (el mismo número no se reutiliza). */
function tilopayOrderNumber(order, attempt) {
  const base = String(order.orderNumber || order.id || "ORD").replace(/[^A-Za-z0-9-]/g, "");
  return `${base}-T${attempt}`;
}

/** Payload de processPayment: monto SIEMPRE en CRC, calculado por el servidor. */
function buildProcessPayload({ key, redirect, orderId, order, orderNumber, crcTotal }) {
  const { first, last } = splitName(order.customerName);
  const addr = order.shippingAddress || {};
  const state = PROVINCE_ISO[String(addr.provincia || "").trim().toLowerCase()] || "CR-SJ";
  const phone = String(order.customerPhone || "").replace(/\D/g, "").slice(-8) || "00000000";
  const common = {
    Address: clean(addr.señas, 120) || "Costa Rica",
    Address2: clean(addr.distrito, 60) || "-",
    City: clean(addr.canton, 60) || "-",
    State: state,
    ZipPostCode: String(addr.codigoPostal || "10101").replace(/\D/g, "").slice(0, 5) || "10101",
    Country: "CR",
    Telephone: phone,
  };
  const p = {
    redirect, key,
    amount: formatAmountCRC(crcTotal),
    currency: "CRC",
    orderNumber,
    capture: "1",
    subscription: "0",
    platform: "aquipauli",
    returnData: Buffer.from(orderId).toString("base64"),
    hashVersion: "V2",
    token_version: "v2",
    billToFirstName: first, billToLastName: last,
    billToEmail: clean(order.customerEmail, 120),
    shipToFirstName: first, shipToLastName: last,
  };
  for (const [k, v] of Object.entries(common)) {
    p[`billTo${k}`] = v;
    p[`shipTo${k}`] = v;
  }
  return p;
}

/**
 * Interpreta la respuesta de /consult para un pedido.
 * Solo es "approved" si hay una transacción Payment con code "1", moneda CRC,
 * monto IGUAL al total calculado por el servidor, orderNumber exacto y
 * entorno coherente con el modo configurado (en live se rechaza "Test").
 * @returns {{state:"approved"|"declined"|"not_found"|"mismatch", tx?:object, reason?:string}}
 */
function interpretConsult(data, { orderNumber, crcTotal, mode = "live" }) {
  const rows = Array.isArray(data?.response) ? data.response : [];
  // Tilopay devuelve el orderNumber con un prefijo de comercio (p. ej. "PFC031932-TPTEST-A-T2"); se acepta
  // el exacto o ese prefijo (2-5 letras + dígitos + "-"), nunca un sufijo arbitrario.
  const want = String(orderNumber);
  const mine = rows.filter((r) => {
    const n = String(r.orderNumber ?? "");
    return n === want || (n.endsWith(`-${want}`) && /^[A-Za-z]{2,5}\d+$/.test(n.slice(0, -(want.length + 1))));
  });
  if (mine.length === 0) return { state: "not_found" };
  const payments = mine.filter((r) => !r.type || String(r.type).toLowerCase() === "payment");
  const approved = payments.filter((r) => String(r.code) === "1");
  if (approved.length === 0) return { state: "declined", tx: payments[0] || mine[0] };
  const tx = approved[0];
  if (String(tx.currency).toUpperCase() !== "CRC") return { state: "mismatch", tx, reason: `Moneda inesperada (${tx.currency}).` };
  if (Math.round(Number(tx.amount) * 100) !== Math.round(Number(crcTotal) * 100)) {
    return { state: "mismatch", tx, reason: `Monto no coincide (${tx.amount} vs ${crcTotal}).` };
  }
  const isTest = /test|prueba|sandbox/i.test(String(tx.environment || ""));
  if (mode === "live" && isTest) return { state: "mismatch", tx, reason: "Transacción de PRUEBAS en modo live." };
  return { state: "approved", tx, testMode: isTest };
}

module.exports = {
  TILOPAY_BASE, tpFetch, getToken, clearTokenCache, formatAmountCRC, splitName,
  tilopayOrderNumber, buildProcessPayload, interpretConsult, PROVINCE_ISO,
};
