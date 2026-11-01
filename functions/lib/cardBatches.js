"use strict";
const { randomInt } = require("node:crypto");
const { CODE_ALPHABET } = require("./promotions.mjs");

function validateBatch({ n, dias = 60, lote }) {
  if (!Number.isInteger(n) || n < 1 || n > 400 || !Number.isInteger(dias) || dias < 1 || dias > 365 ||
      typeof lote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(lote)) {
    throw new Error("Indicá un lote válido, entre 1 y 400 códigos y entre 1 y 365 días.");
  }
}
function makeCards({ n, dias = 60, lote }, now = Date.now()) {
  validateBatch({ n, dias, lote });
  const ids = new Set();
  while (ids.size < n) ids.add("AP-" + Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(""));
  return Array.from(ids, code => ({ code, batchId: lote, type: "percent", value: 10, appliesTo: "products",
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + dias * 86400000).toISOString(),
    used: false, usedAt: null, orderId: null, usedByUid: null, printed: false, printedAt: null }));
}
async function generateBatch(db, args) {
  validateBatch(args);
  const manifest = db.collection("discountBatches").doc(args.lote);
  for (let i = 0; i < 5; i++) {
    const cards = makeCards(args);
    const batch = db.batch();
    batch.create(manifest, { count: cards.length, createdAt: cards[0].createdAt, expiresAt: cards[0].expiresAt });
    for (const card of cards) batch.create(db.collection("discountCodes").doc(card.code), card);
    try { await batch.commit(); return cards; } catch (e) {
      if (e.code !== 6 && e.code !== "already-exists") throw e;
      if ((await manifest.get()).exists) throw new Error("Ese lote ya existe. Buscalo en el CRM.");
    }
  }
  throw new Error("No se pudo reservar el lote. Probá de nuevo.");
}
module.exports = { makeCards, validateBatch, generateBatch };
