// ==============================================
// Sincronización batch de TODO el catálogo
// Endpoint: /{catalog_id}/items_batch (recomendado por Meta)
// Envía TODOS los productos en UN SOLO request
// ==============================================
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const { mapProductToMeta } = require("./catalogSync");
const fetch = require("node-fetch");

const db = getFirestore();
const GRAPH_API = "https://graph.facebook.com/v22.0";

/**
 * Cloud Function callable — sincroniza TODOS los productos activos
 * Envía todos en UN SOLO items_batch request a Meta Catalog API
 */
const syncCatalogBatch = onCall(
  {
    timeoutSeconds: 300,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debés estar autenticado");
    }

    const roleDoc = await db.collection("users_roles").doc(request.auth.uid).get();
    if (!roleDoc.exists || roleDoc.data().role !== "admin") {
      throw new HttpsError("permission-denied", "Solo admins pueden sincronizar");
    }

    const catalogId = process.env.META_CATALOG_ID;
    const token = process.env.META_SYSTEM_USER_TOKEN;

    if (!catalogId || !token) {
      throw new HttpsError("failed-precondition", "META_CATALOG_ID o META_SYSTEM_USER_TOKEN no configurados");
    }

    console.log("[CatalogBatchSync] Iniciando sincronización batch...");

    // Leer todos los productos activos
    const productsSnap = await db.collection("products")
      .where("active", "==", true)
      .get();

    if (productsSnap.empty) {
      return { success: true, synced: 0, errors: 0, message: "No hay productos activos" };
    }

    // Mapear TODOS los productos a formato Meta items_batch
    const batchRequests = [];
    const productIds = [];

    for (const doc of productsSnap.docs) {
      const productData = doc.data();
      if (productData.deleted) continue;

      try {
        const metaItems = await mapProductToMeta(doc.id, productData);
        // mapProductToMeta ahora retorna un ARRAY de items (uno por variante)
        for (const item of metaItems) {
          batchRequests.push({
            method: "UPDATE",
            data: item,
          });
        }
        productIds.push(doc.id);
      } catch (err) {
        console.error(`[CatalogBatchSync] Error mapeando ${doc.id}:`, err.message);
      }
    }

    if (batchRequests.length === 0) {
      return { success: true, synced: 0, errors: 0, message: "No hay productos válidos" };
    }

    console.log(`[CatalogBatchSync] Enviando ${batchRequests.length} productos via items_batch...`);

    try {
      const url = `${GRAPH_API}/${catalogId}/items_batch`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          access_token: token,
          item_type: "PRODUCT_ITEM",
          requests: JSON.stringify(batchRequests),
        }),
      });

      const data = await resp.json();

      console.log("[CatalogBatchSync] Respuesta Meta:", JSON.stringify(data));

      if (data.error) {
        console.error("[CatalogBatchSync] Error Meta API:", JSON.stringify(data.error));

        for (const docId of productIds) {
          await db.collection("products").doc(docId).update({
            metaSyncStatus: "error",
            metaSyncAt: new Date().toISOString(),
          }).catch(() => {});
        }

        return {
          success: false,
          synced: 0,
          errors: batchRequests.length,
          total: batchRequests.length,
          message: `Error de Meta API: ${data.error.message}`,
        };
      }

      // Éxito
      for (const docId of productIds) {
        await db.collection("products").doc(docId).update({
          metaSyncStatus: "synced",
          metaSyncAt: new Date().toISOString(),
        }).catch(() => {});
      }

      const summary = `Sincronización completada: ${batchRequests.length} productos enviados a Meta`;
      console.log(`[CatalogBatchSync] ✅ ${summary}`);

      await db.collection("catalog_sync_logs").add({
        type: "batch",
        synced: batchRequests.length,
        errors: 0,
        total: batchRequests.length,
        triggeredBy: request.auth.uid,
        metaResponse: JSON.stringify(data),
        createdAt: new Date().toISOString(),
      });

      return { success: true, synced: batchRequests.length, errors: 0, total: batchRequests.length, message: summary };
    } catch (err) {
      console.error("[CatalogBatchSync] Error:", err.message);
      return {
        success: false,
        synced: 0,
        errors: batchRequests.length,
        total: batchRequests.length,
        message: `Error de red: ${err.message}`,
      };
    }
  }
);

module.exports = { syncCatalogBatch };
