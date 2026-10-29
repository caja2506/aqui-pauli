// ==============================================
// Botón "Sync WhatsApp": empuja a Meta (items_batch) las MISMAS filas que el feed
// https://aquipauli.com/meta-feed.csv (mismos IDs, disponibilidad, precio en CRC y texto).
// Código compartido: lib/metaFeed.js + lib/metaSync.js
// ==============================================
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const { getMetaConfig, META_SYSTEM_USER_TOKEN } = require("../lib/metaConfig");
const { syncFeedToMeta } = require("../lib/metaSync");

const db = getFirestore();

const syncCatalogBatch = onCall(
  { timeoutSeconds: 300, secrets: [META_SYSTEM_USER_TOKEN] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Debés estar autenticado");
    const roleDoc = await db.collection("users_roles").doc(request.auth.uid).get();
    if (!roleDoc.exists || roleDoc.data().role !== "admin") {
      throw new HttpsError("permission-denied", "Solo admins pueden sincronizar");
    }

    const { catalogId, token, missing, message } = getMetaConfig();
    if (missing.length) throw new HttpsError("failed-precondition", message);

    let result;
    try {
      result = await syncFeedToMeta({ db, catalogId, token });
    } catch (err) {
      console.error("[CatalogBatchSync] Error:", err.message);
      return { success: false, synced: 0, errors: 0, total: 0, message: `Error de red: ${err.message}` };
    }

    await db.collection("catalog_sync_logs").add({
      type: "batch",
      synced: result.synced, errors: result.errors, total: result.total, skipped: result.skipped,
      triggeredBy: request.auth.uid,
      meta: JSON.stringify(result.details || {}).slice(0, 4000),
      createdAt: new Date().toISOString(),
    }).catch(() => {});

    const { details, ...publicResult } = result;
    return publicResult;
  }
);

module.exports = { syncCatalogBatch };
