"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");

// Isolated email helper: every delivery uses an in-memory transport, never SMTP.
const source = fs.readFileSync(path.join(__dirname, "../lib/orderEmail.js"), "utf8");
const mailModule = { exports: {} };
new Function("require", "module", "exports", source)((name) => {
  if (name === "nodemailer") return { createTransport: () => { throw new Error("Real SMTP is forbidden in this suite"); } };
  throw new Error(`Unexpected dependency: ${name}`);
}, mailModule, mailModule.exports);
const { buildPaidOrderEmail, sendPaidOrderEmail } = mailModule.exports;

function fixture() {
  const memory = createMemoryFirestore({
    "config/notifications": { paidOrderEmail: { enabled: true, recipients: ["admin@example.invalid"] } },
  });
  const messages = [];
  const transport = { sendMail: async (mail) => { messages.push(mail); return { messageId: `message-${messages.length}` }; } };
  const args = { db: memory.db, orderId: "order-1", order: {
    orderNumber: "AP-1", customerName: "Ana", customerEmail: "buyer@example.invalid",
    total: 90000, paymentMethod: "tilopay", paymentTransactionId: "TX-1",
  }, items: [], user: "sender@example.invalid", transport };
  return { ...memory, messages, args };
}

test("review email identifies accredited payment, reason and admin action with escaped HTML", () => {
  const { args } = fixture();
  const mail = buildPaidOrderEmail(args.order, [], { requiresReview: true, reviewReason: "Falta stock <revisar>" });
  assert.match(mail.subject, /^Pagado pero requiere revisión: AP-1/);
  assert.match(mail.text, /Motivo: Falta stock <revisar>/);
  assert.match(mail.text, /Transacción: TX-1/);
  assert.match(mail.text, /antes de prepararlo o enviarlo/);
  assert.match(mail.html, /Falta stock &lt;revisar&gt;/);
  assert.doesNotMatch(mail.html, /<revisar>/);
  assert.doesNotMatch(mail.text, /Nuevo pedido pagado/);
  assert.match(buildPaidOrderEmail(args.order, []).subject, /^Pedido pagado AP-1/);
});

test("normal and review email have independent claims and reach only configured admins", async () => {
  for (const reviewFirst of [false, true]) {
    const h = fixture();
    const review = { ...h.args, requiresReview: true, reviewReason: "Inventario pendiente" };
    const first = reviewFirst ? review : h.args;
    const second = reviewFirst ? h.args : review;
    assert.equal((await sendPaidOrderEmail(first)).result, "sent");
    assert.equal((await sendPaidOrderEmail(second)).result, "sent");
    assert.equal((await sendPaidOrderEmail(review)).result, "skipped");
    assert.equal((await sendPaidOrderEmail(h.args)).result, "skipped");
    assert.equal(h.messages.length, 2);
    assert.ok(h.messages.every((mail) => mail.to === "admin@example.invalid"));
    assert.ok(h.messages.every((mail) => !mail.to.includes(h.args.order.customerEmail)));
    assert.equal(h.get("orderNotifications/order-1").paidEmail.status, "sent");
    assert.equal(h.get("orderNotifications/order-1").paidReviewEmail.status, "sent");
  }
});

test("concurrent duplicate review emails claim a single transport delivery", async () => {
  const h = fixture();
  const args = { ...h.args, requiresReview: true };
  const results = await Promise.all(Array.from({ length: 3 }, () => sendPaidOrderEmail(args)));
  assert.equal(results.filter((result) => result.result === "sent").length, 1);
  assert.equal(results.filter((result) => result.result === "skipped").length, 2);
  assert.equal(h.messages.length, 1);
});

test("an ambiguous review email is retained for manual recovery and never blindly retried", async () => {
  const h = fixture(); let attempts = 0;
  const args = { ...h.args, requiresReview: true,
    transport: { sendMail: async () => { attempts++; throw new Error("SMTP connection lost after DATA"); } } };
  assert.equal((await sendPaidOrderEmail(args)).result, "error");
  assert.equal(h.get("orderNotifications/order-1").paidReviewEmail.status, "error");
  assert.equal((await sendPaidOrderEmail(args)).result, "skipped");
  // Age of a claimed send cannot prove that the provider did not deliver it.
  await h.db.doc("orderNotifications/order-1").set({ paidReviewEmail: {
    status: "sending", startedAt: "2020-01-01T00:00:00.000Z",
  } }, { merge: true });
  assert.equal((await sendPaidOrderEmail(args)).result, "skipped");
  assert.equal(attempts, 1);
});

test("disabled admin email configuration prevents a review email", async () => {
  const h = fixture();
  await h.db.doc("config/notifications").set({ paidOrderEmail: { enabled: false } });
  assert.equal((await sendPaidOrderEmail({ ...h.args, requiresReview: true })).result, "disabled");
  assert.equal(h.messages.length, 0);
  assert.equal(h.get("orderNotifications/order-1"), undefined);
});
