// Reglas reales contra Firestore Emulator LOCAL. Nunca usa el proyecto real.
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test this-file
// Sin emulador, la suite se omite explícitamente; no cuenta como aprobada.
"use strict";

const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

describe("reglas del sorteo (Firestore Emulator)", { skip: !process.env.FIRESTORE_EMULATOR_HOST }, () => {
  let env; let sdk; let assertSucceeds; let assertFails;
  before(async () => {
    const hostPort = process.env.FIRESTORE_EMULATOR_HOST;
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(hostPort)) {
      throw new Error("Las pruebas del sorteo solo usan un emulador localhost");
    }
    const [host, port] = hostPort.split(":");
    const rulesTools = require("@firebase/rules-unit-testing");
    // Usa la misma instancia/version del SDK que creó el contexto de pruebas.
    // NODE_PATH puede instalar tools aparte del Firebase usado por la tienda.
    sdk = createRequire(require.resolve("@firebase/rules-unit-testing"))("firebase/firestore");
    sdk.setLogLevel("silent");
    ({ assertSucceeds, assertFails } = rulesTools);
    env = await rulesTools.initializeTestEnvironment({
      projectId: "demo-aqui-pauli-giveaway",
      firestore: { host, port: Number(port),
        rules: fs.readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8") },
    });
  });
  after(async () => { if (env) await env.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (context) => {
      const d = context.firestore();
      await sdk.setDoc(sdk.doc(d, "users_roles/admin"), { role: "admin" });
      await sdk.setDoc(sdk.doc(d, "users_roles/owner"), { role: "cliente" });
      await sdk.setDoc(sdk.doc(d, "giveawayEntries/owner"), entry("owner", 1));
      await sdk.setDoc(sdk.doc(d, "giveawayEntries/other"), entry("other", 2));
      await sdk.setDoc(sdk.doc(d, "giveawayEntries/guest"), entry("guest", 3));
      await sdk.setDoc(sdk.doc(d, "giveawayCounters/2026-10-perfumes"), { lastNumber: 3 });
      await sdk.setDoc(sdk.doc(d, "config/giveaway"), { enabled: true });
    });
  });

  const entry = (uid, number) => ({
    uid, number, campaignId: "2026-10-perfumes", fullName: "Ana María González",
    phone: "88887777", email: "ana@example.test", prizeId: "light-blue-mujer-25",
    prizeLabel: "Light Blue Mujer EDT 25 ml", eligibilityAccepted: true,
    privacyConsent: true, promotionsConsent: false,
    createdAt: sdk.Timestamp.fromDate(new Date("2026-10-29T08:00:00.000Z")),
    consentAcceptedAt: sdk.Timestamp.fromDate(new Date("2026-10-29T08:00:00.000Z")),
    privacyConsentVersion: "2026-10-29", termsVersion: "2026-10-29",
  });
  const db = (uid, provider = "password") => env.authenticatedContext(uid, {
    email: "ana@example.test", firebase: { sign_in_provider: provider },
  }).firestore();
  const publicDb = () => env.unauthenticatedContext().firestore();

  test("participante registrado lee solo su inscripción y también puede comprobar si todavía no existe", async () => {
    const own = await assertSucceeds(sdk.getDoc(sdk.doc(db("owner"), "giveawayEntries/owner")));
    assert.equal(own.data().number, 1);
    await assertFails(sdk.getDoc(sdk.doc(db("owner"), "giveawayEntries/other")));
    // Usuarios Google/Facebook y los que aún no tienen users_roles también son dueños.
    await assertSucceeds(sdk.getDoc(sdk.doc(db("other", "google.com"), "giveawayEntries/other")));
    const missing = await assertSucceeds(sdk.getDoc(sdk.doc(db("new-user", "facebook.com"), "giveawayEntries/new-user")));
    assert.equal(missing.exists(), false);
    await assertFails(sdk.getDoc(sdk.doc(db("owner"), "giveawayEntries/new-user")));
  });

  test("sesión anónima y visitante sin sesión no leen participantes ni una inscripción propia", async () => {
    for (const d of [db("guest", "anonymous"), publicDb()]) {
      for (const uid of ["guest", "owner", "missing"]) {
        await assertFails(sdk.getDoc(sdk.doc(d, "giveawayEntries", uid)));
      }
      await assertFails(sdk.getDocs(sdk.collection(d, "giveawayEntries")));
    }
  });

  test("participante no puede listar ni consultar la colección aunque filtre por su uid o número", async () => {
    const d = db("owner");
    const participants = sdk.collection(d, "giveawayEntries");
    await assertFails(sdk.getDocs(participants));
    await assertFails(sdk.getDocs(sdk.query(participants, sdk.where("uid", "==", "owner"))));
    await assertFails(sdk.getDocs(sdk.query(participants, sdk.where(sdk.documentId(), "==", "owner"))));
    await assertFails(sdk.getDocs(sdk.query(participants, sdk.where("number", "==", 1), sdk.limit(1))));
  });

  test("ningún navegador crea inscripciones, ni siquiera propias o con número y consentimientos falsificados", async () => {
    for (const [d, uid] of [[db("new-user"), "new-user"], [db("guest", "anonymous"), "new-guest"],
      [publicDb(), "public"], [db("admin"), "admin"]]) {
      const ref = sdk.doc(d, "giveawayEntries", uid);
      await assertFails(sdk.setDoc(ref, entry(uid, 4)));
      await assertFails(sdk.setDoc(ref, { ...entry(uid, 999), uid: "owner",
        createdAt: sdk.Timestamp.fromDate(new Date("2026-10-01")),
        privacyConsent: false, promotionsConsent: true }));
    }
  });

  test("participante y admin no cambian datos, número, fecha ni consentimiento y no borran para reinscribirse", async () => {
    for (const uid of ["owner", "other", "admin"]) {
      const ref = sdk.doc(db(uid), "giveawayEntries/owner");
      for (const patch of [{ fullName: "Otra Persona" }, { uid: "other" }, { number: 999 },
        { createdAt: sdk.serverTimestamp() }, { privacyConsent: false }, { promotionsConsent: true },
        { prizeId: "acqua-di-gio-100" }]) {
        await assertFails(sdk.updateDoc(ref, patch));
      }
      await assertFails(sdk.setDoc(ref, entry("owner", 4)));
      await assertFails(sdk.deleteDoc(ref));
    }
  });

  test("solo admin lee todos los participantes y puede ordenarlos por número para la exportación", async () => {
    const d = db("admin");
    await assertSucceeds(sdk.getDoc(sdk.doc(d, "giveawayEntries/owner")));
    await assertSucceeds(sdk.getDoc(sdk.doc(d, "giveawayEntries/other")));
    const list = await assertSucceeds(sdk.getDocs(sdk.query(sdk.collection(d, "giveawayEntries"), sdk.orderBy("number"))));
    assert.deepEqual(list.docs.map((doc) => doc.data().number), [1, 2, 3]);
    await assertSucceeds(sdk.getDocs(sdk.query(sdk.collection(d, "giveawayEntries"), sdk.orderBy("number"), sdk.limit(2))));
  });

  test("contador es exclusivamente del servidor incluso para admin y no admite un batch de inscripción directo", async () => {
    for (const d of [db("owner"), db("admin"), db("guest", "anonymous"), publicDb()]) {
      const ref = sdk.doc(d, "giveawayCounters/2026-10-perfumes");
      await assertFails(sdk.getDoc(ref));
      await assertFails(sdk.getDocs(sdk.collection(d, "giveawayCounters")));
      await assertFails(sdk.updateDoc(ref, { lastNumber: 4 }));
      await assertFails(sdk.deleteDoc(ref));
      await assertFails(sdk.setDoc(sdk.doc(d, "giveawayCounters/otra"), { lastNumber: 1 }));
      const batch = sdk.writeBatch(d);
      batch.set(sdk.doc(d, "giveawayEntries/new-user"), entry("new-user", 4));
      batch.update(ref, { lastNumber: 4 });
      await assertFails(batch.commit());
    }
  });

  test("flag público se puede leer sin sesión pero únicamente admin puede apagarlo o modificarlo", async () => {
    for (const d of [publicDb(), db("owner"), db("guest", "anonymous")]) {
      const ref = sdk.doc(d, "config/giveaway");
      assert.equal((await assertSucceeds(sdk.getDoc(ref))).data().enabled, true);
      await assertFails(sdk.updateDoc(ref, { enabled: false }));
      await assertFails(sdk.setDoc(ref, { enabled: false }));
      await assertFails(sdk.deleteDoc(ref));
    }
    const ref = sdk.doc(db("admin"), "config/giveaway");
    await assertSucceeds(sdk.updateDoc(ref, { enabled: false }));
    assert.equal((await assertSucceeds(sdk.getDoc(sdk.doc(publicDb(), "config/giveaway")))).data().enabled, false);
    await assertSucceeds(sdk.updateDoc(ref, { enabled: true }));
  });

  test("participante no se concede rol admin para acceder a la lista privada", async () => {
    await assertFails(sdk.setDoc(sdk.doc(db("new-user"), "users_roles/new-user"), { role: "admin" }));
    await assertFails(sdk.updateDoc(sdk.doc(db("owner"), "users_roles/owner"), { role: "admin" }));
    await assertFails(sdk.setDoc(sdk.doc(db("owner"), "users_roles/admin"), { role: "admin" }));
    await assertFails(sdk.getDocs(sdk.collection(db("new-user"), "giveawayEntries")));
    await assertFails(sdk.getDocs(sdk.collection(db("owner"), "giveawayEntries")));
  });
});
