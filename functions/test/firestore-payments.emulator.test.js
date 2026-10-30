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
  const cashFields = () => ({
    paymentMethod: "contra_entrega", paymentAmount: 0, remainingTotal: 100,
    cashOnDelivery: { version: 1, state: "pending", createdAt: "2026-10-30T00:00:00Z" },
    inventoryReservation: { version: 1, state: "reserved", lines: [{ productId: "p1", variantId: "v1", quantity: 1 }] },
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

  test("contra entrega solo se crea por servidor, nunca por escritura directa del cliente o admin", async () => {
    for (const uid of ["owner", "admin"]) {
      const d = db(uid);
      await assertFails(sdk.setDoc(sdk.doc(d, "orders/cod-direct"), order(uid, { paymentMethod: "contra_entrega" })));
      const batch = sdk.writeBatch(d);
      batch.set(sdk.doc(d, "orders/cod-batch"), order(uid, { paymentMethod: "contra_entrega", hasBackorder: false }));
      batch.set(sdk.doc(d, "orders/cod-batch/items/item_0"), { ...cartItem(), supplyType: "bajo_pedido" });
      await assertFails(batch.commit());
    }
    await assertFails(sdk.setDoc(sdk.doc(env.unauthenticatedContext().firestore(), "orders/cod-anonymous"),
      order("owner", { paymentMethod: "contra_entrega" })));
    await assertFails(sdk.setDoc(sdk.doc(db("owner"), "orders/cod-marker"),
      order("owner", { paymentMethod: "sinpe", cashOnDelivery: { version: 1, state: "pending" } })));
  });

  test("contra entrega: dueño consulta su pedido pero no altera pagos, propietario, importe ni notas", async () => {
    await seed(cashFields());
    await assertSucceeds(sdk.getDoc(sdk.doc(db("owner"), "orders/o1")));
    await assertSucceeds(sdk.getDoc(sdk.doc(db("owner"), "orders/o1/items/item_0")));
    await assertFails(sdk.getDoc(sdk.doc(db("other"), "orders/o1")));
    for (const patch of [
      { uid: "other" }, { customerUid: "other" }, { total: 1 }, { remainingTotal: 0 },
      { paymentStatus: "pagado" }, { status: "enviado" }, { paymentAmount: 100 },
      { paymentStatus: "verificando", paymentProofUrl: "https://example.test/proof" },
      { paymentPhone: "88887777" }, { paymentMethod: "sinpe" },
      { itemsSummary: [] }, { customerNotes: "Cambio después de confirmar" }, { updatedAt: "later" },
    ]) await assertFails(sdk.updateDoc(sdk.doc(db("owner"), "orders/o1"), patch));
    await assertFails(sdk.deleteDoc(sdk.doc(db("owner"), "orders/o1")));
    await assertFails(sdk.deleteDoc(sdk.doc(db("admin"), "orders/o1")));
  });

  test("contra entrega: sus items no admiten cambios del navegador incluso sin marcador de reserva", async () => {
    await seed({ paymentMethod: "contra_entrega" });
    for (const uid of ["owner", "admin"]) {
      await assertFails(sdk.setDoc(sdk.doc(db(uid), "orders/o1/items/new"), cartItem()));
      await assertFails(sdk.updateDoc(sdk.doc(db(uid), "orders/o1/items/item_0"), { quantity: 2 }));
      await assertFails(sdk.deleteDoc(sdk.doc(db(uid), "orders/o1/items/item_0")));
    }
  });

  test("contra entrega: admin puede gestionar logística sin marcar pagado ni reescribir la reserva", async () => {
    await seed(cashFields());
    const ref = sdk.doc(db("admin"), "orders/o1");
    await assertSucceeds(sdk.updateDoc(ref, { status: "por_preparar", notes: "Cobrar efectivo al entregar" }));
    await assertSucceeds(sdk.updateDoc(ref, { status: "enviado", trackingNumber: "COD123" }));
    await assertSucceeds(sdk.updateDoc(ref, { customerName: "Ana María", customerPhone: "88887778", customerEmail: "nuevo@example.test",
      shippingAddress: { provincia: "Alajuela", canton: "Grecia", distrito: "San José", señas: "Portón" }, updatedAt: "later" }));
    const pending = await assertSucceeds(sdk.getDoc(ref));
    if (pending.data().paymentStatus !== "pendiente" || pending.data().paymentAmount !== 0) {
      throw new Error("Gestionar la entrega no debe acreditar un pago");
    }
    for (const patch of [
      { inventoryReservation: sdk.deleteField() }, { uid: "admin" }, { customerUid: "admin" },
      { cashOnDelivery: sdk.deleteField() }, { cashOnDelivery: { version: 1, state: "collected" } },
      { status: "entregado", paymentStatus: "pagado", paymentAmount: 100, remainingTotal: 0 },
      { paymentStatus: "pagado" }, { paymentAmount: 100 }, { remainingTotal: 0 },
      { total: 1 }, { subtotal: 1 }, { shippingCost: 0.01 }, { paymentMethod: "sinpe" },
      { itemsSummary: [] }, { fulfillment: { version: 1, state: "applied" } },
      { status: "cancelado" }, { status: "pagado" }, { status: "revision_manual" },
    ]) await assertFails(sdk.updateDoc(ref, patch));
    await assertSucceeds(sdk.updateDoc(ref, { status: "entregado" }));
    await assertFails(sdk.updateDoc(ref, { status: "preparando" }));
    await assertFails(sdk.deleteDoc(ref));
  });

  test("contra entrega: estados de logística avanzan sin retroceder aunque el dinero siga pendiente", async () => {
    const stages = ["pendiente_pago", "por_preparar", "preparando", "enviado", "entregado"];
    for (const [beforeIndex, beforeStatus] of stages.entries()) {
      for (const [afterIndex, afterStatus] of stages.entries()) {
        await seed({ ...cashFields(), status: beforeStatus });
        const operation = sdk.updateDoc(sdk.doc(db("admin"), "orders/o1"), { status: afterStatus });
        await (afterIndex >= beforeIndex ? assertSucceeds(operation) : assertFails(operation));
      }
    }
  });

  test("contra entrega: después de cobrar se avanza entrega sin modificar evidencia ni cancelar", async () => {
    await seed({ ...cashFields(), status: "por_preparar", paymentStatus: "pagado", paymentAmount: 100, remainingTotal: 0,
      cashOnDelivery: { version: 1, state: "collected", collectedBy: "admin" },
      inventoryReservation: { version: 1, state: "consumed", lines: [{ productId: "p1", variantId: "v1", quantity: 1 }] },
      fulfillment: { version: 1, state: "applied" } });
    const ref = sdk.doc(db("admin"), "orders/o1");
    await assertSucceeds(sdk.updateDoc(ref, { status: "enviado", trackingNumber: "COD123" }));
    await assertSucceeds(sdk.updateDoc(ref, { status: "entregado" }));
    for (const patch of [{ status: "cancelado" }, { status: "enviado" }, { paymentStatus: "pendiente" },
      { paymentAmount: 0 }, { remainingTotal: 100 }, { fulfillment: sdk.deleteField() }]) {
      await assertFails(sdk.updateDoc(ref, patch));
    }
  });

  test("contra entrega: pedidos sin marcador no evaden el callable mediante la rama de otros medios", async () => {
    await seed({ paymentMethod: "contra_entrega" });
    const ref = sdk.doc(db("admin"), "orders/o1");
    await assertFails(sdk.updateDoc(ref, { status: "cancelado" }));
    await assertFails(sdk.updateDoc(ref, { status: "enviado" }));
    await assertFails(sdk.updateDoc(ref, { paymentMethod: "sinpe" }));
  });

  test("el cliente no convierte un pedido manual en contra entrega para evitar la validación canónica", async () => {
    await seed({ paymentMethod: "sinpe", hasBackorder: true, backorderDeposit: 50 });
    await assertFails(sdk.updateDoc(sdk.doc(db("owner"), "orders/o1"), { paymentMethod: "contra_entrega" }));
  });

  test("notas del cliente son opcionales y admiten texto hasta 1000 caracteres en un pedido propio", async () => {
    const values = [undefined, "", "Entregar después de las 3.\nTocar timbre.", "x".repeat(1000)];
    for (const [index, customerNotes] of values.entries()) {
      const d = db("owner");
      const id = `notes-valid-${index}`;
      const ref = sdk.doc(d, "orders", id);
      const batch = sdk.writeBatch(d);
      batch.set(ref, order("owner", { paymentMethod: "sinpe", ...(customerNotes === undefined ? {} : { customerNotes }) }));
      batch.set(sdk.doc(d, "orders", id, "items/item_0"), cartItem());
      await assertSucceeds(batch.commit());
      const snapshot = await assertSucceeds(sdk.getDoc(ref));
      if (customerNotes !== undefined && snapshot.data().customerNotes !== customerNotes) throw new Error("Las reglas alteraron las notas del pedido");
      await assertFails(sdk.getDoc(sdk.doc(db("other"), "orders", id)));
    }
  });

  test("notas no admiten objetos, números, null ni más de 1000 caracteres al crear", async () => {
    for (const [index, customerNotes] of [null, false, 123, [], {}, "x".repeat(1001)].entries()) {
      const d = db("owner"); const batch = sdk.writeBatch(d);
      const id = `notes-invalid-${index}`;
      batch.set(sdk.doc(d, "orders", id), order("owner", { paymentMethod: "sinpe", customerNotes }));
      batch.set(sdk.doc(d, "orders", id, "items/item_0"), cartItem());
      await assertFails(batch.commit());
      await env.withSecurityRulesDisabled(async ctx => {
        const saved = await sdk.getDoc(sdk.doc(ctx.firestore(), "orders", id));
        if (saved.exists()) throw new Error("Un pedido con notas inválidas llegó a persistir");
      });
    }
  });

  test("el dueño no puede editar, borrar ni agregar customerNotes después de crear el pedido", async () => {
    for (const paymentMethod of ["sinpe", "paypal", "tilopay"]) {
      await seed({ paymentMethod, customerNotes: "Entregar por la tarde" });
      const ref = sdk.doc(db("owner"), "orders/o1");
      await assertFails(sdk.updateDoc(ref, { customerNotes: "Cambiar la entrega" }));
      await assertFails(sdk.updateDoc(ref, { customerNotes: sdk.deleteField() }));
      await assertFails(sdk.updateDoc(ref, { customerNotes: "Cambiar entrega", paymentStatus: "pagado", total: 1 }));
      await seed({ paymentMethod });
      await assertFails(sdk.updateDoc(ref, { customerNotes: "Agregar después" }));
    }
  });

  test("agregar notas válidas no permite falsificar pago, reserva o propietario durante creación", async () => {
    const notes = { customerNotes: "Dejar en recepción" };
    for (const [index, extra] of [
      { uid: "other" }, { customerUid: "other" }, { paymentStatus: "pagado" },
      { paymentAmount: 100 }, { inventoryReservation: {} }, { paypal: {} },
    ].entries()) {
      await assertFails(sdk.setDoc(sdk.doc(db("owner"), "orders", `notes-forged-${index}`), order("owner", { ...notes, ...extra })));
    }
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
