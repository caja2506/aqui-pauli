"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { Timestamp } = require("firebase-admin/firestore");
const { db } = require("./utils");
const config = require("./lib/giveawayConfig.json");

const START_MS = Date.parse(config.startsAt);
const END_MS = Date.parse(config.endsAt);
const INPUT_FIELDS = new Set([
  "fullName", "phone", "email", "prizeId", "eligibilityAccepted", "privacyConsent", "promotionsConsent",
]);

function requireRegisteredUser(auth) {
  const provider = auth?.token?.firebase?.sign_in_provider;
  if (!auth || typeof auth.uid !== "string" || !/^[^/\u0000-\u001f]{1,128}$/.test(auth.uid)
      || typeof provider !== "string" || !provider || provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Registrate o iniciá sesión con tu cuenta para participar.");
  }
  return auth.uid;
}

function validatedInput(data, auth) {
  if (!data || typeof data !== "object" || Array.isArray(data)
      || Object.keys(data).some((key) => !INPUT_FIELDS.has(key))) {
    throw new HttpsError("invalid-argument", "Los datos de participación no son válidos.");
  }
  if (typeof data.fullName !== "string" || data.fullName.length > 160
      || /[\u0000-\u001f\u007f]/.test(data.fullName)) {
    throw new HttpsError("invalid-argument", "Ingresá tu nombre completo.");
  }
  const fullName = data.fullName.trim().replace(/\s+/g, " ");
  if (fullName.length < 3 || fullName.length > 120) {
    throw new HttpsError("invalid-argument", "Ingresá tu nombre completo (entre 3 y 120 caracteres).");
  }
  if (typeof data.phone !== "string" || !/^\d{8}$/.test(data.phone.trim())) {
    throw new HttpsError("invalid-argument", "Ingresá un teléfono de Costa Rica de 8 dígitos.");
  }
  if (typeof data.email !== "string") {
    throw new HttpsError("invalid-argument", "Ingresá un correo electrónico válido.");
  }
  const submittedEmail = data.email.trim().toLowerCase();
  const accountEmail = typeof auth.token.email === "string" ? auth.token.email.trim().toLowerCase() : "";
  const email = accountEmail || submittedEmail;
  if (email.length > 254 || !/^[^\s@<>\u0000-\u001f\u007f]+@[^\s@<>\u0000-\u001f\u007f]+\.[^\s@<>\u0000-\u001f\u007f]+$/.test(email)
      || (accountEmail && submittedEmail !== accountEmail)) {
    throw new HttpsError("invalid-argument", accountEmail
      ? "Usá el correo de la cuenta con la que iniciaste sesión."
      : "Ingresá un correo electrónico válido.");
  }
  const prize = config.prizes.find((item) => item.id === data.prizeId);
  if (!prize) throw new HttpsError("invalid-argument", "Escogé uno de los premios del sorteo.");
  if (data.eligibilityAccepted !== true || data.privacyConsent !== true) {
    throw new HttpsError("invalid-argument", "Confirmá que sos mayor de 18 años, tenés dirección en Costa Rica y autorizás el uso de tus datos para el sorteo.");
  }
  if (data.promotionsConsent !== undefined && typeof data.promotionsConsent !== "boolean") {
    throw new HttpsError("invalid-argument", "La autorización para promociones debe ser una elección válida.");
  }
  return { fullName, phone: data.phone.trim(), email, prizeId: prize.id, prizeLabel: prize.label,
    eligibilityAccepted: true, privacyConsent: true, promotionsConsent: data.promotionsConsent === true };
}

function resultFor(entry, alreadyEntered) {
  return {
    number: entry.number,
    alreadyEntered,
    campaignId: entry.campaignId,
    prizeId: entry.prizeId,
    createdAt: entry.createdAt.toDate().toISOString(),
  };
}

// El navegador no escribe inscripciones ni contadores directamente. La cuenta
// autenticada fija el docId y esta transacción asigna un número una sola vez.
exports.enterGiveaway = onCall({ region: "us-central1", cors: true, invoker: "public", maxInstances: 5,
  timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const uid = requireRegisteredUser(request.auth);
  const entryRef = db.collection("giveawayEntries").doc(uid);
  const counterRef = db.collection("giveawayCounters").doc(config.campaignId);
  const configRef = db.collection("config").doc("giveaway");

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(entryRef);
    if (existing.exists) {
      const entry = existing.data();
      if (entry.uid !== uid || entry.campaignId !== config.campaignId
          || !Number.isSafeInteger(entry.number) || entry.number < 1
          || typeof entry.createdAt?.toDate !== "function") {
        throw new HttpsError("failed-precondition", "Tu inscripción requiere revisión. Contactanos por DM a @aqui.paulina.");
      }
      // Recuperar una respuesta perdida no cambia datos ni consume otro número,
      // incluso si entre tanto se cerró o se pausó la campaña.
      return resultFor(entry, true);
    }

    const input = validatedInput(request.data, request.auth);
    const flag = await transaction.get(configRef);
    const counter = await transaction.get(counterRef);
    // Se evalúa el reloj del servidor después de las lecturas y en CADA reintento.
    const now = Date.now();
    if (now < START_MS) throw new HttpsError("failed-precondition", "El sorteo todavía no ha comenzado.");
    if (now >= END_MS) throw new HttpsError("failed-precondition", "La inscripción al sorteo ya cerró.");
    if (flag.exists && flag.data().enabled === false) {
      throw new HttpsError("failed-precondition", "La inscripción al sorteo está pausada.");
    }
    const lastNumber = counter.exists ? counter.data().lastNumber : 0;
    if (!Number.isSafeInteger(lastNumber) || lastNumber < 0 || lastNumber >= Number.MAX_SAFE_INTEGER) {
      throw new HttpsError("failed-precondition", "No se puede asignar un número de participante en este momento.");
    }

    const timestamp = Timestamp.fromMillis(now);
    const entry = {
      uid, campaignId: config.campaignId, number: lastNumber + 1, ...input,
      createdAt: timestamp, consentAcceptedAt: timestamp,
      termsVersion: config.termsVersion,
      privacyConsentVersion: config.privacyConsentVersion,
      eligibilityText: config.eligibilityText,
      privacyConsentText: config.privacyConsentText,
      promotionsConsentText: config.promotionsConsentText,
    };
    transaction.create(entryRef, entry);
    transaction.set(counterRef, { campaignId: config.campaignId, lastNumber: entry.number, updatedAt: timestamp });
    return resultFor(entry, false);
  });
});
