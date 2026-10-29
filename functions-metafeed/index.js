const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { loadFeedRows, toCsv } = require("./feed");
admin.initializeApp();
exports.metaFeed = onRequest({ region: "us-central1", memory: "256MiB", maxInstances: 2 }, async (req, res) => {
  const db = admin.firestore();
  const { rows } = await loadFeedRows(db);
  res.set("Content-Type", "text/csv; charset=utf-8").set("Cache-Control", "public, max-age=900").send(toCsv(rows));
});
