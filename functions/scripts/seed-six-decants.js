"use strict";
const { documents } = require("./seed-decant-products");
const { DECANT_CATEGORY } = require("../lib/decantSale.mjs");

const catalog = [
  ["clinique-happy-men", "Clinique Happy for Men", [1700, 2300, 3300]],
  ["light-blue-mujer", "Dolce & Gabbana Light Blue mujer", [2500, 3200, 4500]],
  ["bad-boy-edt", "Carolina Herrera Bad Boy EDT", [2900, 4100, 6300]],
  ["halloween-blue-drop", "Jesús del Pozo Halloween Blue Drop", [1700, 2300, 3200]],
  ["club-de-nuit-intense-man", "Armaf Club de Nuit Intense Man", [2500, 3000, 4000]],
  ["invictus-edt", "Paco Rabanne Invictus EDT", [2800, 3500, 5300]],
];

function newProducts(categoryRef, now) {
  const fragrances = catalog.map(([slug, name, prices]) => [slug, name, prices, `https://aquipauli.com/img/decants/${slug}.jpg`]);
  // La categoría ya existe. Solo esta tanda de productos y variantes debe crearse.
  return documents(categoryRef, now, fragrances).filter(([path]) => path.startsWith("products/"));
}

async function main(args) {
  if (args.length > 1 || args.some(flag => !["--dry-run", "--commit"].includes(flag))) throw Error("Usá --dry-run o --commit.");
  const categoryPath = "categories/" + DECANT_CATEGORY;
  const now = new Date().toISOString();
  if (!args.includes("--commit")) {
    console.log(JSON.stringify(newProducts(categoryPath, now), null, 2));
    return;
  }
  if (process.env.FIRESTORE_EMULATOR_HOST) throw Error("Este seed fue aprobado solo para producción.");
  const { initializeApp, applicationDefault } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const db = getFirestore(initializeApp({ projectId: "aqui-pauli", credential: applicationDefault() }));
  try {
    const category = db.doc(categoryPath);
    const rows = newProducts(category, now);
    await db.runTransaction(async tx => {
      const current = await tx.get(category);
      if (!current.exists || current.data().active !== true) throw Error("Falta la categoría activa Decants.");
      for (const [path, data] of rows) tx.create(db.doc(path), data);
    });
    console.log("CREATED 6 products and 18 variants, category retained");
  } finally {
    await db.terminate();
  }
}
module.exports = { newProducts };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
