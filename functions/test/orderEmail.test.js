const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPaidOrderEmail, sendPaidOrderEmail } = require("../lib/orderEmail");

function fakeDb(cfg) {
  const docs = {};
  const ref = (k) => ({
    get: async () => ({ exists: k in docs || (k === "config/notifications" && !!cfg), data: () => docs[k] || cfg }),
    set: async (v) => { docs[k] = { ...(docs[k] || {}), ...v }; },
  });
  return {
    docs,
    collection: (c) => ({ doc: (id) => ({ ...ref(`${c}/${id}`), _k: `${c}/${id}` }) }),
    runTransaction: async (fn) => fn({
      get: async (r) => r.get(),
      set: (r, v) => { docs[r._k] = { ...(docs[r._k] || {}), ...v }; },
    }),
  };
}
const order = { orderNumber: "AP-1", customerName: "Ana <b>", total: 10, paymentMethod: "paypal" };
const items = [{ productName: "Perfume", variantName: "100ml", quantity: 2, lineTotal: 20 }];

test("contenido en español, escapa HTML y marca prueba", () => {
  const m = buildPaidOrderEmail(order, items, { test: true });
  assert.match(m.subject, /^\[PRUEBA\] Pedido pagado AP-1/);
  assert.match(m.text, /Método de pago: PayPal/);
  assert.match(m.html, /Ana &lt;b&gt;/);
  assert.match(m.text, /admin\/pedidos/);
});

test("un solo correo por pedido, a los destinatarios configurados", async () => {
  const db = fakeDb({ paidOrderEmail: { recipients: ["a@x.com", "b@x.com"] } });
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return { messageId: "id1" }; } };
  const args = { db, orderId: "o1", order, items, user: "s@x.com", pass: "p", transport };
  assert.equal((await sendPaidOrderEmail(args)).result, "sent");
  assert.equal((await sendPaidOrderEmail(args)).result, "skipped");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "a@x.com, b@x.com");
});

test("deshabilitado y sin credenciales no envían", async () => {
  assert.equal((await sendPaidOrderEmail({ db: fakeDb({ paidOrderEmail: { enabled: false } }), orderId: "o", order, items })).result, "disabled");
  assert.equal((await sendPaidOrderEmail({ db: fakeDb(null), orderId: "o", order, items })).result, "error");
});
