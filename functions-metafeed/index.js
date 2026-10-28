const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { buildRows, toCsv } = require("./feed");
admin.initializeApp();
exports.metaFeed = onRequest({ region: "us-central1", memory: "256MiB", maxInstances: 2 }, async (req, res) => {
  const db = admin.firestore();
  const [ps, bs] = await Promise.all([db.collection("products").get(), db.collection("brands").get()]);
  const brands = {}; bs.forEach(d => brands[d.id] = d.get("name"));
  const products = ps.docs.map(d => ({ id: d.id, ...d.data(), brandId: d.get("brandRef")?.id }));
  const variants = {};
  await Promise.all(products.map(async p => {
    const s = await db.collection("products").doc(p.id).collection("variants").get();
    variants[p.id] = s.docs.map(d => ({ id: d.id, ...d.data() }));
  }));
  const { rows } = buildRows(products, variants, brands);
  res.set("Content-Type", "text/csv; charset=utf-8").set("Cache-Control", "public, max-age=900").send(toCsv(rows));
});
