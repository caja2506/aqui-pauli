"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { documents } = require("../scripts/seed-decant-products");
const { isSaleDecant } = require("../lib/decantSale.mjs");

test("seed de venta: una categoría independiente, ocho perfumes, tamaños en stock y precios CRC", () => {
  const rows = new Map(documents({ id: "decants" }, "2026-01-01"));
  assert.equal(rows.size, 33);
  assert.equal(rows.get("categories/decants").parentId, null);
  const expected = {
    "stronger-with-you-intensely": [3500, 4700, 7300], "212-vip-rose-i-love-ny": [4100, 5800, 9200],
    "al-haramain-amber-oud-gold": [2600, 3600, 5400], "moschino-toy-2-pearl": [2800, 3700, 5700],
    "lacoste-l1212-blanc": [2500, 3200, 4700], "armaf-odyssey-homme-white": [2100, 2800, 4100],
    "lattafa-badee-al-oud-honor-glory": [2100, 2600, 3500], "boss-in-motion": [2300, 3200, 4700],
  };
  for (const [id, prices] of Object.entries(expected)) {
    const path = "products/decant-" + id;
    assert.ok(isSaleDecant(rows.get(path)));
    for (const [i, size] of [2, 3, 5].entries()) {
      const v = rows.get(path + "/variants/" + size + "ml");
      assert.deepEqual([v.name, v.price, v.stock, v.reservedStock, v.supplyType], [size + " ml", prices[i], 1, 0, "stock_propio"]);
    }
  }
});
