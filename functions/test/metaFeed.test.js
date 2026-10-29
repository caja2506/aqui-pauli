const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildRows, rowToBatchItem } = require("../lib/metaFeed");

test("functions-metafeed/feed.js es copia idéntica de functions/lib/metaFeed.js", () => {
  const a = fs.readFileSync(path.join(__dirname, "../lib/metaFeed.js"), "utf8");
  const b = fs.readFileSync(path.join(__dirname, "../../functions-metafeed/feed.js"), "utf8");
  assert.equal(a, b, "Copiá functions/lib/metaFeed.js a functions-metafeed/feed.js");
});

test("IDs = SKU de variante o ID de producto; sin variantes → out of stock; unlisted excluido", () => {
  const products = [
    { id: "p1", name: "A", active: true, description: "d", images: ["https://x/y.jpg"], categoryIdList: [] },
    { id: "p2", name: "B", active: true, basePrice: 5000, description: "d", images: ["https://x/z.jpg"], categoryIdList: [] },
    { id: "p3", name: "C", active: true, unlisted: true, basePrice: 1, images: ["https://x/z.jpg"], categoryIdList: [] },
  ];
  const variants = { p1: [{ id: "v1", sku: "SKU-1", price: 91000, stock: 2, active: true }], p2: [], p3: [] };
  const { rows } = buildRows(products, variants, {}, {});
  assert.deepEqual(rows.map((r) => [r.id, r.availability, r.price]), [["SKU-1", "in stock", "91000 CRC"], ["p2", "out of stock", "5000 CRC"]]);
  const it = rowToBatchItem({ ...rows[0], additional_image_link: "https://a/1.png,https://b/2.png" });
  assert.deepEqual(it.additional_image_link, ["https://a/1.png", "https://b/2.png"]);
  const it2 = rowToBatchItem({ id: "x", additional_image_link: "https://n/f_auto,u_1,c_scale/a.png,https://n/b.png" });
  assert.deepEqual(it2.additional_image_link, ["https://n/f_auto,u_1,c_scale/a.png", "https://n/b.png"]);
  assert.equal(it.id, "SKU-1");
});
