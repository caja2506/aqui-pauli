// ==============================================
// Cliente mínimo de la API de Tilopay (Hosted Payment Page). Sin dependencias.
// Docs: https://tilopay.com/developers  (openapi.json)
//   POST /api/v1/login          → token del API (24 h)
//   POST /api/v1/processPayment → URL del formulario de pago alojado
//   POST /api/v1/consult        → estado y monto de una transacción por orderNumber
// Pruebas y producción usan el MISMO host; el modo se cambia en el panel de Tilopay.
// ==============================================

const crypto = require("node:crypto");

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

/**
 * Referencia enviada a Tilopay (orderNumber): sale SOLO del id del documento de Firestore (generado por el
 * servidor, único) + el número de intento. Nunca del orderNumber del pedido (lo genera el cliente) ni de un
 * texto de relleno. Tilopay exige orderNumber único para siempre.
 */
function tilopayReference(orderId, attempt) {
  const id = String(orderId || "");
  if (!/^[A-Za-z0-9]{8,40}$/.test(id)) throw new Error("orderId inválido para la referencia de Tilopay");
  const n = Number(attempt);
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error("Intento inválido");
  return `AP-${id}-T${n}`;
}

/**
 * "Versión" del pedido: huella de lo que el cliente va a pagar (total, envío, líneas). Si cambia entre que se
 * inicia el pago y se confirma, el pago NO se acredita automáticamente.
 */
function orderVersion(order) {
  const lines = (Array.isArray(order?.itemsSummary) ? order.itemsSummary : [])
    .map((i) => [String(i.productId ?? ""), String(i.variantId ?? ""), Number(i.quantity) || 0, Number(i.price) || 0])
    .sort((x, y) => (x.join("|") < y.join("|") ? -1 : 1));
  const canon = JSON.stringify({
    total: Number(order?.total) || 0, subtotal: Number(order?.subtotal) || 0,
    shippingCost: Number(order?.shippingCost) || 0, shippingType: String(order?.shippingType || ""),
    canton: String(order?.shippingAddress?.canton || "").toLowerCase(), lines,
  });
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 24);
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

/** "test" | "live" | null (no reconocido). Tilopay usa "Test", "Production", "PROD", "TEST" según el endpoint. */
function classifyEnvironment(env) {
  const e = String(env ?? "").trim().toLowerCase();
  if (!e) return null;
  if (["test", "testing", "prueba", "pruebas", "sandbox"].includes(e)) return "test";
  if (["prod", "production", "produccion", "producción", "live", "real"].includes(e)) return "live";
  return null;
}

const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";

/** ¿La respuesta dice claramente "esa orden no existe"? (Tilopay devuelve errores con HTTP 200 o 4xx.) */
function looksNotFound(data) {
  if (!data || typeof data !== "object") return false;
  if (Array.isArray(data.response) && data.response.length === 0) return true;
  return /not exist|does not exist|not found|no existe|no encontrad/i.test(String(data.message ?? data.result ?? data.error ?? ""));
}

const REQUIRED_TX_FIELDS = ["id_tilopay", "currency", "amount"];

/**
 * Interpreta la respuesta de /consult para UN intento de pago.
 * Estados:
 *  - approved               Payment, code "1", capture "Capture", CRC, monto IGUAL al del intento, id_tilopay, entorno
 *                           reconocido y coherente con el modo del intento, merchantId (si viene y está configurado).
 *  - pending_capture        Aprobado por el banco pero capture ≠ "Capture" ("Authorize", vacío, desconocido).
 *  - pending_reconciliation Respuesta ilegible o incompleta (faltan type, id_tilopay, entorno, moneda, monto…).
 *  - mismatch               Moneda/monto/entorno/comercio no coinciden, o varias transacciones aprobadas distintas.
 *  - declined               Hay transacción pero no aprobada.
 *  - not_found              Respuesta válida que dice que no hay transacción para esa orden.
 * @returns {{state:string, tx?:object, reason?:string, env?:"test"|"live"|null}}
 */
function interpretConsult(data, { orderNumber, amount, crcTotal, mode = "live", merchantId = "" }) {
  const expectedAmount = amount ?? crcTotal;
  if (!data || typeof data !== "object" || !Array.isArray(data.response)) {
    if (looksNotFound(data)) return { state: "not_found" };
    return { state: "pending_reconciliation", reason: "Respuesta de Tilopay ilegible o incompleta." };
  }
  const rows = data.response.filter((r) => r && typeof r === "object");
  // Tilopay devuelve el orderNumber con un prefijo de comercio (p. ej. "PFC031932-AP-xxx-T2"); se acepta
  // el exacto o ese prefijo (2-5 letras + dígitos + "-"), nunca un sufijo arbitrario.
  const want = String(orderNumber);
  const mine = rows.filter((r) => {
    const n = String(r.orderNumber ?? "");
    return n === want || (n.endsWith(`-${want}`) && /^[A-Za-z]{2,5}\d+$/.test(n.slice(0, -(want.length + 1))));
  });
  if (mine.length === 0) {
    if (rows.length === 0) return { state: "not_found" };
    return { state: "pending_reconciliation", reason: "Tilopay devolvió filas con otro orderNumber." };
  }
  if (mine.some((r) => isBlank(r.type))) {
    return { state: "pending_reconciliation", tx: mine[0], reason: "La transacción no trae el campo type." };
  }
  const payments = mine.filter((r) => String(r.type).toLowerCase() === "payment");
  if (payments.length === 0) return { state: "declined", tx: mine[0] };
  if (payments.some((r) => isBlank(r.code))) {
    return { state: "pending_reconciliation", tx: payments[0], reason: "La transacción no trae el campo code." };
  }
  const approved = payments.filter((r) => String(r.code) === "1");
  if (approved.length === 0) return { state: "declined", tx: payments[0] };

  const ids = new Set(approved.map((r) => String(r.id_tilopay ?? r.id ?? "")));
  if (ids.size > 1) return { state: "mismatch", tx: approved[0], reason: "Hay varias transacciones aprobadas para la misma orden." };
  const tx = approved[0];
  const missing = REQUIRED_TX_FIELDS.filter((f) => isBlank(tx[f]));
  const env = classifyEnvironment(tx.environment);
  if (!env) missing.push("environment");
  if (missing.length) {
    return { state: "pending_reconciliation", tx, env, reason: `Faltan o no se reconocen campos de Tilopay: ${missing.join(", ")}.` };
  }
  if (String(tx.currency).toUpperCase() !== "CRC") return { state: "mismatch", tx, env, reason: `Moneda inesperada (${tx.currency}).` };
  const paid = Math.round(Number(tx.amount) * 100);
  if (!Number.isFinite(paid) || paid <= 0) return { state: "pending_reconciliation", tx, env, reason: `Monto ilegible (${tx.amount}).` };
  if (paid !== Math.round(Number(expectedAmount) * 100)) {
    return { state: "mismatch", tx, env, reason: `Monto no coincide (${tx.amount} vs ${expectedAmount}).` };
  }
  if (!isBlank(merchantId) && !isBlank(tx.merchantId) && String(tx.merchantId) !== String(merchantId)) {
    return { state: "mismatch", tx, env, reason: `merchantId inesperado (${tx.merchantId}).` };
  }
  if (mode === "live" && env === "test") return { state: "mismatch", tx, env, reason: "Transacción de PRUEBAS en modo live." };
  if (mode === "test" && env === "live") return { state: "mismatch", tx, env, reason: "Transacción REAL (producción) en modo de pruebas." };
  if (!/^capture$/i.test(String(tx.capture ?? "").trim())) {
    return { state: "pending_capture", tx, env, reason: `Cobro no capturado (capture: ${isBlank(tx.capture) ? "vacío" : tx.capture}).` };
  }
  return { state: "approved", tx, env };
}

module.exports = {
  TILOPAY_BASE, tpFetch, getToken, clearTokenCache, formatAmountCRC, splitName,
  tilopayReference, orderVersion, classifyEnvironment, looksNotFound, buildProcessPayload, interpretConsult, PROVINCE_ISO,
};
