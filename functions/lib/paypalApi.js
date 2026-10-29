// ==============================================
// Cliente mínimo de la REST API de PayPal (Orders v2). Sin dependencias.
// ==============================================

function paypalBase(env) {
  return env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function getAccessToken({ env, clientId, secret, fetchFn = fetch }) {
  const res = await fetchFn(`${paypalBase(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth ${res.status}: ${data.error_description || data.error || "?"}`);
  return data.access_token;
}

async function ppFetch(path, { env, token, method = "GET", body, requestId, fetchFn = fetch }) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const res = await fetchFn(`${paypalBase(env)}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Payload de orden PayPal (intent CAPTURE, USD, sin dirección de envío de PayPal). */
function buildOrderPayload({ orderId, orderNumber, usdTotal }) {
  return {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: orderId,
      custom_id: orderId,
      invoice_id: orderNumber || orderId,
      description: `Pedido ${orderNumber || orderId} - Aquí Pauli`.slice(0, 127),
      amount: { currency_code: "USD", value: usdTotal.toFixed(2) },
    }],
    application_context: {
      brand_name: "Aquí Pauli",
      shipping_preference: "NO_SHIPPING",
      user_action: "PAY_NOW",
    },
  };
}

/**
 * Interpreta la respuesta de captura / detalle de orden.
 * @returns {{state:"completed"|"pending"|"declined"|"other", capture?:object, reason?:string}}
 */
function interpretCapture(order) {
  const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
  if (order?.status === "COMPLETED" && cap?.status === "COMPLETED") return { state: "completed", capture: cap };
  if (cap?.status === "PENDING") return { state: "pending", capture: cap, reason: cap.status_details?.reason };
  if (cap?.status === "DECLINED" || cap?.status === "FAILED") return { state: "declined", capture: cap };
  return { state: "other", capture: cap, reason: order?.status };
}

/** Verifica que la orden PayPal corresponde al pedido y al monto esperado. */
function verifyOrderMatches(ppOrder, { orderId, usdTotal }) {
  const pu = ppOrder?.purchase_units?.[0];
  if (!pu) return "Orden PayPal sin purchase_units";
  if (pu.custom_id !== orderId) return "La orden PayPal no corresponde a este pedido";
  if (pu.amount?.currency_code !== "USD") return "Moneda inesperada";
  if (Math.abs(Number(pu.amount?.value) - usdTotal) > 0.001) return "El monto de la orden PayPal no coincide";
  return null;
}

module.exports = { paypalBase, getAccessToken, ppFetch, buildOrderPayload, interpretCapture, verifyOrderMatches };
