"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Timestamp } = require("firebase-admin/firestore");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");
const config = require("../lib/giveawayConfig.json");

const START = Date.parse(config.startsAt);
const END = Date.parse(config.endsAt);
const COUNTER = `giveawayCounters/${config.campaignId}`;
const NOW = START + 3600000;
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }

function loadHandler(seed = {}, initialNow = NOW) {
  const memory = createMemoryFirestore(seed);
  let now = initialNow;
  let callableOptions;
  // The memory transaction double clones data. Firestore returns Timestamp
  // instances; restore that SDK boundary when the double reads its stored data.
  const revive = (data) => {
    if (!data) return data;
    const result = { ...data };
    for (const key of ["createdAt", "consentAcceptedAt", "updatedAt"]) {
      const value = result[key];
      if (value && Number.isInteger(value._seconds) && Number.isInteger(value._nanoseconds)) {
        result[key] = new Timestamp(value._seconds, value._nanoseconds);
      }
    }
    return result;
  };
  const db = { ...memory.db,
    runTransaction: (handler) => memory.db.runTransaction((transaction) => handler({ ...transaction,
      get: async (ref) => {
        const snapshot = await transaction.get(ref);
        return { ...snapshot, data: () => revive(snapshot.data()) };
      },
    })),
  };
  const dependencies = {
    "firebase-functions/v2/https": { onCall: (options, fn) => { callableOptions = options; return fn; }, HttpsError },
    "firebase-admin/firestore": { Timestamp },
    "./utils": { db },
    "./lib/giveawayConfig.json": config,
  };
  const module = { exports: {} };
  class TestDate extends Date { static now() { return now; } }
  new Function("require", "module", "exports", "Date", fs.readFileSync(path.join(__dirname, "../giveaway.js"), "utf8"))(
    (name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    }, module, module.exports, TestDate);
  return { ...memory, enter: module.exports.enterGiveaway, options: callableOptions, setNow: (value) => { now = value; } };
}

function payload(extra = {}) {
  return { fullName: "Ana María González", phone: "88887777", email: "ana@example.test",
    prizeId: config.prizes[0].id, eligibilityAccepted: true, privacyConsent: true, promotionsConsent: false, ...extra };
}
function request(extra = {}, uid = "ana", token = {}) {
  return { auth: { uid, token: { email: "ana@example.test", firebase: { sign_in_provider: "password" }, ...token } }, data: payload(extra) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test("sorteo usa el horario fijo de Costa Rica y la función callable autorizada", () => {
  assert.equal(config.startsAt, "2026-10-29T06:00:00.000Z");
  assert.equal(config.endsAt, "2026-11-06T02:00:00.000Z");
  assert.equal(config.timeZone, "America/Costa_Rica");
  const h = loadHandler();
  assert.equal(h.options.region, "us-central1");
  assert.equal(h.options.invoker, "public");
});

test("crea una inscripción propia con número 1, datos canónicos, consentimientos y timestamp servidor", async () => {
  const h = loadHandler();
  const result = await h.enter(request({ fullName: "  Ana   María González  ", email: " ANA@example.test " }));
  assert.deepEqual(result, { number: 1, alreadyEntered: false, campaignId: config.campaignId,
    prizeId: config.prizes[0].id, createdAt: new Date(NOW).toISOString() });
  const entry = h.get("giveawayEntries/ana");
  assert.equal(entry.uid, "ana");
  assert.equal(entry.fullName, "Ana María González");
  assert.equal(entry.email, "ana@example.test");
  assert.equal(entry.phone, "88887777");
  assert.equal(entry.prizeLabel, config.prizes[0].label);
  assert.equal(entry.eligibilityAccepted, true);
  assert.equal(entry.privacyConsent, true);
  assert.equal(entry.promotionsConsent, false);
  assert.equal(entry.privacyConsentText, config.privacyConsentText);
  assert.equal(entry.privacyConsentVersion, config.privacyConsentVersion);
  assert.equal(entry.eligibilityText, config.eligibilityText);
  assert.equal(entry.promotionsConsentText, config.promotionsConsentText);
  assert.equal(entry.termsVersion, config.termsVersion);
  assert.deepEqual(entry.createdAt, { _seconds: NOW / 1000, _nanoseconds: 0 });
  assert.deepEqual(entry.consentAcceptedAt, entry.createdAt);
  assert.equal(h.get(COUNTER).lastNumber, 1);
  assert.equal(h.stats.commits, 1);
});

test("rechaza sesión ausente, anónima, proveedor ausente y uid inválido sin escribir", async () => {
  const h = loadHandler();
  const invalid = [
    { data: payload() },
    { auth: null, data: payload() },
    request({}, "ana", { firebase: { sign_in_provider: "anonymous" } }),
    { auth: { uid: "ana" }, data: payload() },
    request({}, "ana", { firebase: {} }),
    request({}, "other/uid"), request({}, ""), request({}, "x".repeat(129)),
  ];
  for (const req of invalid) await rejectsCode(h.enter(req), "unauthenticated");
  assert.deepEqual(h.store, {});
});

test("no acepta dueño, número, campaña, marca temporal ni autoridad de cliente", async () => {
  for (const forged of [{ uid: "other" }, { number: 10 }, { createdAt: "2026-10-29" },
    { campaignId: "otra" }, { termsVersion: "inventada" }, { privacyConsentText: "cambiado" },
    { role: "admin" }, { lastNumber: 99 }, { enabled: true }]) {
    const h = loadHandler();
    await rejectsCode(h.enter(request(forged)), "invalid-argument");
    assert.deepEqual(h.store, {});
  }
});

test("rechaza nombre, teléfono, correo y premio inválidos", async () => {
  const invalid = [
    { fullName: "" }, { fullName: " A " }, { fullName: 123 }, { fullName: "x".repeat(121) },
    { fullName: "Ana\nGonzález" }, { fullName: "Ana\u0000González" },
    { phone: 88887777 }, { phone: "8888777" }, { phone: "50688887777" }, { phone: "8888-7777" },
    { phone: "8888a777" }, { email: null }, { email: "" }, { email: "otra@example.test" },
    { prizeId: "un-premio-inventado" }, { prizeId: 1 }, { prizeId: null },
  ];
  const h = loadHandler();
  for (const extra of invalid) await rejectsCode(h.enter(request(extra)), "invalid-argument");
  for (const data of [undefined, null, [], "mal", false]) {
    await rejectsCode(h.enter({ ...request(), data }), "invalid-argument");
  }
  assert.deepEqual(h.store, {});
});

test("email procede de la cuenta; una cuenta social sin email puede proporcionar su contacto", async () => {
  const h = loadHandler();
  await h.enter(request({ email: "ANA@EXAMPLE.TEST" }, "google", { email: "Ana@Example.Test", firebase: { sign_in_provider: "google.com" } }));
  assert.equal(h.get("giveawayEntries/google").email, "ana@example.test");
  await h.enter(request({ email: "contacto@example.test" }, "facebook", { email: undefined, firebase: { sign_in_provider: "facebook.com" } }));
  assert.equal(h.get("giveawayEntries/facebook").email, "contacto@example.test");
  for (const email of ["bad", "bad@", "bad@host", "bad\n@mail.test", "a<@b.test", "a".repeat(250) + "@b.test"]) {
    await rejectsCode(h.enter(request({ email }, "bad-email", { email: undefined })), "invalid-argument");
  }
  assert.equal(h.get(COUNTER).lastNumber, 2);
});

test("las dos declaraciones requeridas exigen true booleano y las promociones son independientes", async () => {
  const h = loadHandler();
  for (const key of ["eligibilityAccepted", "privacyConsent"]) {
    for (const value of [undefined, false, 1, "true", {}, []]) {
      await rejectsCode(h.enter(request({ [key]: value })), "invalid-argument");
    }
  }
  for (const value of [null, "true", "false", 0, 1, {}]) {
    await rejectsCode(h.enter(request({ promotionsConsent: value })), "invalid-argument");
  }
  await h.enter(request({ promotionsConsent: undefined }, "no-promo"));
  await h.enter(request({ promotionsConsent: true }, "promo"));
  assert.equal(h.get("giveawayEntries/no-promo").promotionsConsent, false);
  assert.equal(h.get("giveawayEntries/promo").promotionsConsent, true);
  assert.equal(h.get(COUNTER).lastNumber, 2);
});

test("cada premio válido conserva su identificador y etiqueta oficial", async () => {
  const h = loadHandler();
  for (const prize of config.prizes) {
    await h.enter(request({ prizeId: prize.id }, prize.id));
    assert.equal(h.get(`giveawayEntries/${prize.id}`).prizeId, prize.id);
    assert.equal(h.get(`giveawayEntries/${prize.id}`).prizeLabel, prize.label);
  }
});

test("apertura inclusiva, cierre exclusivo y antes/después rechazados por reloj del servidor", async () => {
  for (const now of [START - 1, END, END + 1]) {
    const h = loadHandler({}, now);
    await rejectsCode(h.enter(request()), "failed-precondition");
    assert.deepEqual(h.store, {});
  }
  for (const now of [START, END - 1]) {
    const h = loadHandler({}, now);
    assert.equal((await h.enter(request())).number, 1);
  }
});

test("config/giveaway.enabled false cierra la inscripción; true o ausencia la habilitan", async () => {
  const disabled = loadHandler({ "config/giveaway": { enabled: false } });
  await rejectsCode(disabled.enter(request()), "failed-precondition");
  assert.equal(disabled.get(COUNTER), undefined);
  for (const seed of [{}, { "config/giveaway": { enabled: true } }]) {
    assert.equal((await loadHandler(seed).enter(request())).number, 1);
  }
});

test("un doble envío concurrente del mismo uid conserva un solo número y los datos originales", async () => {
  const h = loadHandler();
  const results = await Promise.all([h.enter(request()), h.enter(request()), h.enter(request({ prizeId: config.prizes[1].id }))]);
  assert.deepEqual(results.map((entry) => entry.number), [1, 1, 1]);
  assert.equal(results.filter((entry) => !entry.alreadyEntered).length, 1);
  assert.equal(h.get(COUNTER).lastNumber, 1);
  assert.equal(h.get("giveawayEntries/ana").prizeId, config.prizes[0].id);
  assert.equal(Object.keys(h.store).filter((key) => key.startsWith("giveawayEntries/")).length, 1);
  assert.ok(h.stats.retries >= 1);
});

test("usuarios concurrentes reciben números únicos correlativos sin huecos", async () => {
  const h = loadHandler();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => h.enter(request({}, `u${i}`))));
  assert.deepEqual(results.map((entry) => entry.number).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(h.get(COUNTER).lastNumber, 12);
  assert.ok(h.stats.retries >= 1);
});

test("recupera respuesta perdida tras cierre o pausa sin modificar datos, consentimientos ni contador", async () => {
  const h = loadHandler();
  const result = await h.enter(request());
  const original = h.get("giveawayEntries/ana");
  await h.set("config/giveaway", { enabled: false });
  h.setNow(END + 60000);
  const recovered = await h.enter(request({ phone: "11112222", promotionsConsent: true, prizeId: config.prizes[1].id }));
  assert.deepEqual(recovered, { ...result, alreadyEntered: true });
  assert.deepEqual(h.get("giveawayEntries/ana"), original);
  assert.equal(h.get(COUNTER).lastNumber, 1);
});

test("un cambio del flag durante la transacción obliga a reintentar y falla cerrado", async () => {
  const h = loadHandler();
  let changed = false;
  h.db.beforeCommit = async ({ writes }) => {
    if (!changed && writes.length) {
      changed = true;
      await h.set("config/giveaway", { enabled: false });
    }
  };
  await rejectsCode(h.enter(request()), "failed-precondition");
  assert.equal(h.get("giveawayEntries/ana"), undefined);
  assert.equal(h.get(COUNTER), undefined);
  assert.equal(h.stats.retries, 1);
});

test("un reintento que cruza el cierre vuelve a evaluar la hora del servidor", async () => {
  const h = loadHandler({}, END - 1);
  let changed = false;
  h.db.beforeCommit = async ({ writes }) => {
    if (!changed && writes.length) {
      changed = true;
      await h.set("config/giveaway", { enabled: true });
      h.setNow(END);
    }
  };
  await rejectsCode(h.enter(request()), "failed-precondition");
  assert.equal(h.get("giveawayEntries/ana"), undefined);
  assert.equal(h.get(COUNTER), undefined);
});

test("no reinicia un contador corrupto ni supera el entero seguro", async () => {
  for (const lastNumber of [undefined, null, "5", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    const h = loadHandler({ [COUNTER]: { lastNumber } });
    await rejectsCode(h.enter(request()), "failed-precondition");
    assert.equal(h.get("giveawayEntries/ana"), undefined);
    assert.deepEqual(h.get(COUNTER), { lastNumber });
  }
});

test("no sobrescribe una inscripción corrupta o de otra campaña", async () => {
  for (const patch of [{ uid: "other" }, { campaignId: "otro-sorteo" }, { number: 0 }, { number: "1" }, { createdAt: "forjado" }]) {
    const h = loadHandler();
    await h.enter(request());
    const invalid = { ...h.get("giveawayEntries/ana"), ...patch };
    await h.set("giveawayEntries/ana", invalid);
    await rejectsCode(h.enter(request()), "failed-precondition");
    assert.deepEqual(h.get("giveawayEntries/ana"), invalid);
    assert.equal(h.get(COUNTER).lastNumber, 1);
  }
});

test("errores de Firestore no habilitan inscripción ni dejan escrituras parciales", async () => {
  const h = loadHandler();
  h.db.beforeCommit = async () => { throw new Error("Firestore no disponible"); };
  await assert.rejects(h.enter(request()), /Firestore no disponible/);
  assert.deepEqual(h.store, {});
});
