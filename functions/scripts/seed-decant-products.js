"use strict";
const { DECANT_CATEGORY } = require("../lib/decantSale.mjs");

const catalog = [
  ["stronger-with-you-intensely", "Stronger With You Intensely", [3500, 4700, 7300]],
  ["212-vip-rose-i-love-ny", "212 VIP Rosé I ♥ NY", [4100, 5800, 9200]],
  ["al-haramain-amber-oud-gold", "Al Haramain Amber Oud Gold", [2600, 3600, 5400]],
  ["moschino-toy-2-pearl", "Moschino Toy 2 Pearl", [2800, 3700, 5700]],
  ["lacoste-l1212-blanc", "Lacoste L.12.12 Blanc", [2500, 3200, 4700]],
  ["armaf-odyssey-homme-white", "Armaf Odyssey Homme White", [2100, 2800, 4100]],
  ["lattafa-badee-al-oud-honor-glory", "Lattafa Bade'e Al Oud Honor & Glory", [2100, 2600, 3500]],
  ["boss-in-motion", "Boss In Motion", [2300, 3200, 4700]],
];

function documents(categoryRef, now) {
  const rows = [[`categories/${DECANT_CATEGORY}`, {
    name: "Decants", slug: DECANT_CATEGORY, parentId: null, active: true, order: 0, createdAt: now,
  }]];
  for (const [slug, fragrance, prices] of catalog) {
    const id = "decant-" + slug;
    const path = "products/" + id;
    rows.push([path, { name: fragrance + " · Decant", slug: id, productKind: "decant",
      description: "Decant de fragancia disponible en 2 ml, 3 ml y 5 ml.", categoryRefs: [categoryRef],
      images: [], basePrice: prices[0], active: true, deleted: false, createdAt: now, updatedAt: now }]);
    for (const [order, ml] of [2, 3, 5].entries()) {
      rows.push([path + "/variants/" + ml + "ml", { name: ml + " ml", sku: (id + "-" + ml + "ML").toUpperCase(),
        price: prices[order], stock: 1, reservedStock: 0, active: true, supplyType: "stock_propio",
        commercialStatus: "disponible", attributes: { tamaño: ml + " ml" }, order }]);
    }
  }
  return rows;
}

async function main(args) {
  if (args.length > 1 || args.some(arg => !["--dry-run", "--commit"].includes(arg))) throw new Error("Usá --dry-run o --commit.");
  const categoryPath = "categories/" + DECANT_CATEGORY;
  const now = new Date().toISOString();
  if (!args.includes("--commit")) {
    console.log(JSON.stringify(documents(categoryPath, now), null, 2));
    return;
  }
  const { initializeApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const db = getFirestore(initializeApp({ projectId: process.env.FIRESTORE_EMULATOR_HOST ? "demo-aqui-pauli-giveaway" : "aqui-pauli" }));
  // Una sola operación create-only. Una colisión revierte todo el lote,
  // incluso si alguien ya editó el precio o agotó el inventario en el admin.
  const batch = db.batch();
  for (const [path, data] of documents(db.doc(categoryPath), now)) batch.create(db.doc(path), data);
  await batch.commit();
  console.log("Creados Decants, 8 productos y 24 variantes.");
}

module.exports = { documents };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
