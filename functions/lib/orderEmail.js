// ==============================================
// Email "Nuevo pedido pagado" para Carlos y Pame.
// Remitente: Gmail SMTP (nodemailer) con una "contraseña de aplicación".
//   Secrets: GMAIL_SMTP_USER (cuenta Gmail remitente), GMAIL_SMTP_APP_PASSWORD
// Destinatarios: Firestore config/notifications → paidOrderEmail.{enabled,recipients[]}
// Idempotente: un correo por pedido (documento orderNotifications/{orderId}).
// Nunca se envía a clientes.
// ==============================================
const nodemailer = require("nodemailer");

const DEFAULT_RECIPIENTS = ["pamesank61@gmail.com", "caja2506@gmail.com"];
const ADMIN_ORDERS_URL = "https://aquipauli.com/admin/pedidos";

const METHOD_LABELS = {
  paypal: "PayPal / Tarjeta",
  sinpe: "SINPE Móvil",
  sinpe_movil: "SINPE Móvil",
  transferencia: "Transferencia",
  efectivo: "Efectivo",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const crc = (n) => `₡${Number(n || 0).toLocaleString("es-CR")}`;

/** Arma asunto + texto + HTML. `items` = [{productName, variantName, quantity, lineTotal}] */
function buildPaidOrderEmail(order, items, { test = false } = {}) {
  const num = order.orderNumber || "(sin número)";
  const method = METHOD_LABELS[order.paymentMethod] || order.paymentMethod || "—";
  const lines = (items || []).map((i) => {
    const name = [i.productName || i.name, i.variantName].filter(Boolean).join(" — ");
    return { text: `• ${i.quantity || 1} × ${name} (${crc(i.lineTotal ?? (i.price || 0) * (i.quantity || 1))})`, name, i };
  });
  const prefix = test ? "[PRUEBA] " : "";
  const subject = `${prefix}Pedido pagado ${num} — ${crc(order.total)}`;
  const testNote = test ? "ESTE ES UN CORREO DE PRUEBA (pedido de prueba). No requiere acción.\n\n" : "";
  const text = `${testNote}Nuevo pedido pagado\n\n` +
    `Pedido: ${num}\nCliente: ${order.customerName || "—"}\n` +
    `Productos:\n${lines.map((l) => l.text).join("\n") || "—"}\n\n` +
    `Total: ${crc(order.total)}\nMétodo de pago: ${method}\n\n` +
    `Ver en el admin: ${ADMIN_ORDERS_URL} (buscá el pedido ${num})\n\n— Aquí Pauli (aviso automático)`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px">` +
    (test ? `<p style="background:#fff3cd;padding:8px;border-radius:6px"><b>PRUEBA</b> — pedido de prueba, no requiere acción.</p>` : "") +
    `<h2 style="margin:0 0 8px">🛒 Nuevo pedido pagado</h2>` +
    `<p><b>Pedido:</b> ${esc(num)}<br><b>Cliente:</b> ${esc(order.customerName || "—")}<br>` +
    `<b>Total:</b> ${esc(crc(order.total))}<br><b>Método de pago:</b> ${esc(method)}</p>` +
    `<p><b>Productos:</b></p><ul>${lines.map((l) => `<li>${esc(l.text.slice(2))}</li>`).join("") || "<li>—</li>"}</ul>` +
    `<p><a href="${ADMIN_ORDERS_URL}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir pedidos en el admin</a><br>` +
    `<small>Buscá el pedido ${esc(num)}</small></p>` +
    `<p style="color:#888;font-size:12px">Aquí Pauli — aviso automático</p></div>`;
  return { subject, text, html };
}

/**
 * Envía el correo una sola vez por pedido.
 * @param {object} p {db, orderId, order, items, user, pass, test}
 * @returns {Promise<{result:"sent"|"skipped"|"disabled"|"error", reason?:string}>}
 */
async function sendPaidOrderEmail({ db, orderId, order, items, user, pass, test = false, transport }) {
  const cfgSnap = await db.collection("config").doc("notifications").get();
  const cfg = (cfgSnap.exists && cfgSnap.data().paidOrderEmail) || {};
  if (cfg.enabled === false) return { result: "disabled" };
  const recipients = Array.isArray(cfg.recipients) && cfg.recipients.length ? cfg.recipients : DEFAULT_RECIPIENTS;
  if (!transport && (!user || !pass)) {
    console.warn("[orderEmail] sin credenciales SMTP; no se envía");
    return { result: "error", reason: "no_credentials" };
  }

  // Reservar (idempotencia): solo un envío por pedido y tipo (real/prueba)
  const ref = db.collection("orderNotifications").doc(`${orderId}${test ? "_test" : ""}`);
  const claimed = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.exists ? s.data().paidEmail : null;
    if (d?.status === "sent") return false;
    if (d?.status === "sending" && Date.now() - Date.parse(d.startedAt) < 5 * 60 * 1000) return false;
    tx.set(ref, { paidEmail: { status: "sending", startedAt: new Date().toISOString() } }, { merge: true });
    return true;
  });
  if (!claimed) return { result: "skipped", reason: "already_sent_or_sending" };

  try {
    const mail = buildPaidOrderEmail(order, items, { test });
    const tr = transport || nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
    const info = await tr.sendMail({ from: `Aquí Pauli <${user || "no-reply@aquipauli.com"}>`, to: recipients.join(", "), ...mail });
    await ref.set({ paidEmail: { status: "sent", sentAt: new Date().toISOString(), recipients, messageId: info.messageId || null, test } }, { merge: true });
    return { result: "sent" };
  } catch (e) {
    console.error("[orderEmail] error:", e.message);
    await ref.set({ paidEmail: { status: "error", error: String(e.message).slice(0, 300), at: new Date().toISOString() } }, { merge: true });
    return { result: "error", reason: e.message };
  }
}

module.exports = { buildPaidOrderEmail, sendPaidOrderEmail, DEFAULT_RECIPIENTS };
