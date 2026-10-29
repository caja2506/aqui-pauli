// Real Rules tests. Requires a LOCAL Firestore Emulator and dev dependencies:
//   @firebase/rules-unit-testing, firebase
// Run with FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test this-file.
// Without an emulator this suite is explicitly SKIPPED, never reported as passed.
const { describe, test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

describe("reglas de pagos (Firestore Emulator)", { skip: !process.env.FIRESTORE_EMULATOR_HOST }, () => {
  let env; let sdk; let assertSucceeds; let assertFails;
  before(async () => {
    const hostPort = process.env.FIRESTORE_EMULATOR_HOST;
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(hostPort)) throw new Error("Las pruebas destructivas solo usan un emulador localhost");
    const [host, port] = hostPort.split(":");
    const rulesTools = require("@firebase/rules-unit-testing");
    sdk = require("firebase/firestore");
    sdk.setLogLevel("silent");
    ({ assertSucceeds, assertFails } = rulesTools);
    env = await rulesTools.initializeTestEnvironment({
      projectId: "demo-aqui-pauli-audit",
      firestore: { host, port: Number(port), rules: fs.readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8") },
    });
  });
  after(async () => { if (env) await env.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await sdk.setDoc(sdk.doc(ctx.firestore(), "users_roles/admin"), { role: "admin" });
      await sdk.setDoc(sdk.doc(ctx.firestore(), "users_roles/owner"), { role: "cliente" });
    });
  });

  const cartItem = () => ({ productId: "p1", variantId: "v1", productName: "Perfume", variantName: "50 ml", imageUrl: "", price: 100, quantity: 1, supplyType: "stock_propio", lineTotal: 100 });
  const order = (uid = "owner", extra = {}) => ({
    orderNumber: "AP-1", uid, customerName: "Ana", customerEmail: "a@example.test", customerPhone: "88887777",
    customerCedula: "", isGuest: false, shippingAddress: { provincia: "Alajuela", canton: "Grecia", distrito: "Grecia", codigoPostal: "20301", señas: "Casa" },
    subtotal: 100, shippingCost: 0, shippingType: "normal", total: 100,
    paymentMethod: "tilopay", paymentPhone: "", paymentStatus: "pendiente", paymentProofUrl: "",
    hasBackorder: false, backorderDeposit: 0, status: "pendiente_pago", notes: "", trackingNumber: "", trackingUrl: "",
    itemsSummary: [cartItem()], itemCount: 1, createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", ...extra,
  });
  const paidFields = () => ({
    paymentStatus: "pagado", status: "por_preparar", paymentTransactionId: "123", reconciliationResult: "tilopay_consult",
    tilopay: {
      status: "approved", paidAttemptKey: "a1",
      attemptsById: { a1: { schemaVersion: 2, mode: "live", status: "approved", financialEvidence: "captured", idTilopay: "123" } },
    },
    fulfillment: { version: 1, state: "applied", paidAttemptKey: "a1", paymentTransactionId: "123" },
  });
  const db = (uid) => env.authenticatedContext(uid).firestore();
  const seed = async (extra = {}) => env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await sdk.setDoc(sdk.doc(d, "orders/o1"), order("owner", extra));
    await sdk.setDoc(sdk.doc(d, "orders/o1/items/item_0"), cartItem());
  });

  test("checkout real puede crear padre e items juntos y no agregar líneas después", async () => {
    const d = db("owner"); const batch = sdk.writeBatch(d);
    batch.set(sdk.doc(d, "orders/o1"), order());
    batch.set(sdk.doc(d, "orders/o1/items/item_0"), cartItem());
    await assertSucceeds(batch.commit());
    await assertFails(sdk.setDoc(sdk.doc(d, "orders/o1/items/item_1"), cartItem()));
  });

  test("creación rechaza dueño ajeno y todo snapshot, reserva o pago aportado", async () => {
    for (const fields of [{ uid: "other" }, { customerUid: "other" }, { tilopay: {} }, { paypal: {} },
      { paymentAmount: 100 }, { inventoryReservation: {} }, { fulfillment: {} }, { paidEffects: {} },
      { legacyReservationReleasedAt: "2026-10-29T00:00:00Z" },
      { paymentStatus: "pagado" }, { status: "pagado" }, { serverFieldFromFuture: true }]) {
      await assertFails(sdk.setDoc(sdk.doc(db("owner"), "orders/o1"), order("owner", fields)));
    }
    await assertFails(sdk.setDoc(sdk.doc(db("admin"), "orders/o1"), order("admin", { paymentStatus: "pagado", status: "pagado" })));
  });

  test("metadatos Tilopay y dueño inmutables incluso para admin de navegador", async () => {
    await seed({ tilopay: { status: "open" } });
    for (const uid of ["owner", "admin"]) {
      for (const patch of [{ total: 1 }, { itemsSummary: [] }, { uid: "other" }, { customerUid: "admin" },
        { tilopay: {} }, { paymentMethod: "sinpe" }, { paymentStatus: "pagado" }, { status: "pagado" },
        { paymentTransactionId: "forged" }, { inventoryReservation: {} }, { fulfillment: {} }]) {
        await assertFails(sdk.updateDoc(sdk.doc(db(uid), "orders/o1"), patch));
      }
      await assertFails(sdk.deleteDoc(sdk.doc(db(uid), "orders/o1")));
    }
    await assertFails(sdk.getDoc(sdk.doc(db("other"), "orders/o1")));
  });

  test("ningún cliente puede crear, modificar o borrar items después del lock", async () => {
    await seed({ tilopay: { status: "reserved" } });
    for (const uid of ["owner", "admin"]) {
      await assertFails(sdk.setDoc(sdk.doc(db(uid), "orders/o1/items/new"), cartItem()));
      await assertFails(sdk.updateDoc(sdk.doc(db(uid), "orders/o1/items/item_0"), { quantity: 2 }));
      await assertFails(sdk.deleteDoc(sdk.doc(db(uid), "orders/o1/items/item_0")));
    }
  });

  test("admin gestiona entrega solo tras crédito servidor y jamás reescribe pagado", async () => {
    await seed(paidFields());
    const ref = sdk.doc(db("admin"), "orders/o1");
    await assertSucceeds(sdk.updateDoc(ref, { status: "enviado", trackingNumber: "CR123", trackingUrl: "https://example.test/tracking" }));
    await assertSucceeds(sdk.updateDoc(ref, { status: "entregado" }));
    await assertFails(sdk.updateDoc(ref, { status: "pagado" }));
    await assertSucceeds(sdk.updateDoc(ref, { notes: "Entrega confirmada" }));
  });

  test("admin no adelanta la logística antes de aplicar inventario y CRM", async () => {
    const fields = paidFields();
    delete fields.fulfillment;
    fields.status = "pagado";
    await seed(fields);
    const ref = sdk.doc(db("admin"), "orders/o1");
    await assertFails(sdk.updateDoc(ref, { status: "por_preparar" }));
    await assertFails(sdk.updateDoc(ref, { status: "enviado" }));
    await assertSucceeds(sdk.updateDoc(ref, { notes: "Pendiente de procesar inventario" }));
    await seed({ ...fields, status: "por_preparar" });
    await assertFails(sdk.updateDoc(ref, { status: "enviado" }));
    await seed({ ...paidFields(), status: "pagado" });
    await assertFails(sdk.updateDoc(ref, { status: "por_preparar" }));
  });

  test("admin no despacha ni entrega si aparece revisión o deja de ser válido el pago", async () => {
    const mutations = [
      (f) => { f.tilopay.reconciliationNeedsReview = true; },
      (f) => { f.tilopay.duplicatePaymentNeedsReview = true; },
      (f) => { f.tilopay.legacyNeedsReview = true; },
      (f) => { f.tilopay.status = "refunded"; },
      (f) => { f.tilopay.attemptsById.a1.reconciliationNeedsReview = true; },
    ];
    const ref = sdk.doc(db("admin"), "orders/o1");
    for (const mutate of mutations) {
      const fields = paidFields(); mutate(fields);
      await seed(fields);
      await assertFails(sdk.updateDoc(ref, { status: "enviado" }));
      await assertSucceeds(sdk.updateDoc(ref, { notes: "Revisar movimiento", trackingNumber: "CR123" }));
      await seed({ ...fields, status: "enviado" });
      await assertFails(sdk.updateDoc(ref, { status: "entregado" }));
    }
  });

  test("ledger, referencias y locks son exclusivamente del servidor", async () => {
    for (const uid of ["owner", "admin"]) for (const collection of ["tilopayTx", "tilopayReferences", "tilopayCheckoutLocks"]) {
      await assertFails(sdk.setDoc(sdk.doc(db(uid), collection, "attempt1"), { orderId: "o1" }));
    }
  });

  test("se conserva comprobante manual y administración no Tilopay", async () => {
    await seed({ paymentMethod: "sinpe" });
    await assertSucceeds(sdk.updateDoc(sdk.doc(db("owner"), "orders/o1"), { paymentStatus: "verificando", paymentProofUrl: "https://example.test/proof" }));
    await assertSucceeds(sdk.updateDoc(sdk.doc(db("admin"), "orders/o1"), { status: "revision_manual", notes: "Revisar SINPE" }));
    await assertFails(sdk.updateDoc(sdk.doc(db("admin"), "orders/o1"), { uid: "admin" }));
    for (const uid of ["owner", "admin"]) {
      await assertFails(sdk.updateDoc(sdk.doc(db(uid), "orders/o1"), { legacyReservationReleasedAt: "2026-10-29T00:00:00Z" }));
    }
  });

  test("checkout de invitado autenticado funciona sin documento users_roles", async () => {
    const d = db("guest-without-role");
    const batch = sdk.writeBatch(d);
    batch.set(sdk.doc(d, "orders/guest-order"), order("guest-without-role", { isGuest: true }));
    batch.set(sdk.doc(d, "orders/guest-order/items/item_0"), cartItem());
    await assertSucceeds(batch.commit());
    await assertSucceeds(sdk.getDoc(sdk.doc(d, "orders/guest-order")));
    await assertSucceeds(sdk.getDoc(sdk.doc(d, "orders/guest-order/items/item_0")));
  });

  test("catálogo y CRM conservan sus permisos", async () => {
    await assertSucceeds(sdk.setDoc(sdk.doc(db("admin"), "products/p1"), { name: "Perfume", basePrice: 100 }));
    await assertSucceeds(sdk.getDoc(sdk.doc(env.unauthenticatedContext().firestore(), "products/p1")));
    await assertFails(sdk.setDoc(sdk.doc(db("owner"), "products/p1"), { basePrice: 1 }));
    await assertSucceeds(sdk.setDoc(sdk.doc(db("owner"), "crm_contacts/owner"), { displayName: "Ana" }));
  });
});
