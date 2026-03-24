// ==============================================
// Sincronización Firestore → Meta Catalog API
// Endpoint: /{catalog_id}/items_batch (recomendado por Meta)
// ==============================================
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { getFirestore } = require("firebase-admin/firestore");
const fetch = require("node-fetch");

const db = getFirestore();
const GRAPH_API = "https://graph.facebook.com/v22.0";

// ==============================================
// MAPEAR PRODUCTO FIRESTORE → META items_batch FORMAT
// Retorna un ARRAY de items (uno por variante)
// ==============================================
async function mapProductToMeta(productId, productData) {
  const variantsSnap = await db.collection("products").doc(productId)
    .collection("variants").get();

  // Obtener marca
  let brandName = "Aqui Pauli";
  if (productData.brandRef) {
    try {
      const brandDoc = await productData.brandRef.get();
      if (brandDoc.exists) brandName = brandDoc.data().name || "Aqui Pauli";
    } catch { /* ignorar */ }
  }

  const productImage = (productData.images && productData.images.length > 0)
    ? productData.images[0]
    : "";

  const baseLink = `https://aqui-pauli.web.app/producto/${productId}`;

  const items = [];

  // Si tiene variantes, crear un item por cada variante activa
  if (!variantsSnap.empty) {
    for (const vDoc of variantsSnap.docs) {
      const v = vDoc.data();
      if (v.active === false) continue;

      // Leer campos directamente de la variante (prioridad), con fallback a sub-objeto attributes
      const variantPrice = v.price || v.attributes?.price || productData.basePrice || 0;
      const variantStock = v.stock || v.attributes?.stock || 0;
      const variantName = v.name || v.attributes?.name || "";
      const variantImage = v.imageUrl || v.attributes?.imageUrl || productImage;
      const commercialStatus = v.commercialStatus || v.attributes?.commercialStatus || "";

      // Disponibilidad: "disponible" o "bajo_pedido" = in stock, incluso si stock es 0
      const isAvailable = commercialStatus === "disponible" || commercialStatus === "bajo_pedido" || variantStock > 0;

      items.push({
        id: `${productId}_${vDoc.id}`,
        item_group_id: productId,
        title: `${productData.name || "Producto"} - ${variantName}`.trim(),
        description: productData.description || productData.name || "Sin descripción",
        availability: isAvailable ? "in stock" : "out of stock",
        condition: "new",
        price: `${Math.round(variantPrice)} CRC`,
        link: baseLink,
        image: variantImage ? [{ url: variantImage }] : [],
        brand: brandName,
        additional_variant_attribute: variantName ? `Variante:${variantName}` : "",
      });
    }
  }

  // Si no tiene variantes o no hubo activas, enviar el producto solo
  if (items.length === 0) {
    const price = productData.basePrice || 0;
    items.push({
      id: productId,
      title: productData.name || "Producto",
      description: productData.description || productData.name || "Sin descripción",
      availability: "in stock",
      condition: "new",
      price: `${Math.round(price)} CRC`,
      link: baseLink,
      image: productImage ? [{ url: productImage }] : [],
      brand: brandName,
    });
  }

  return items;
}


// ==============================================
// CREAR/ACTUALIZAR PRODUCTOS EN META CATALOG
// Acepta un array de items (variantes) y los envía en batch
// ==============================================
async function upsertProductInMeta(itemsArray) {
  const catalogId = process.env.META_CATALOG_ID;
  const token = process.env.META_SYSTEM_USER_TOKEN;

  if (!catalogId || !token) {
    console.warn("[CatalogSync] META_CATALOG_ID o META_SYSTEM_USER_TOKEN no configurados — omitiendo sync");
    return null;
  }

  // Asegurar que sea array
  const items = Array.isArray(itemsArray) ? itemsArray : [itemsArray];

  try {
    const url = `${GRAPH_API}/${catalogId}/items_batch`;

    const requestBody = {
      access_token: token,
      item_type: "PRODUCT_ITEM",
      requests: JSON.stringify(items.map(item => ({
        method: "UPDATE",
        data: item,
      }))),
    };


    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(requestBody),
    });

    const data = await resp.json();

    if (data.error) {
      console.error("[CatalogSync] Error Meta API:", JSON.stringify(data.error));
      return null;
    }

    console.log(`[CatalogSync] ✅ Producto ${productData.id} sincronizado. Respuesta:`, JSON.stringify(data));
    return data;
  } catch (err) {
    console.error("[CatalogSync] Error:", err.message);
    return null;
  }
}

// ==============================================
// ELIMINAR PRODUCTO DE META CATALOG
// ==============================================
async function deleteProductFromMeta(retailerId) {
  const catalogId = process.env.META_CATALOG_ID;
  const token = process.env.META_SYSTEM_USER_TOKEN;

  if (!catalogId || !token) return null;

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
        requests: JSON.stringify([{
          method: "DELETE",
          data: { id: retailerId },
        }]),
      }),
    });

    const data = await resp.json();
    console.log(`[CatalogSync] 🗑️ Producto ${retailerId} eliminado de Meta`);
    return data;
  } catch (err) {
    console.error("[CatalogSync] Error eliminando:", err.message);
    return null;
  }
}

// ==============================================
// TRIGGER: Producto creado/editado/borrado
// ==============================================
const onProductChange = onDocumentWritten(
  {
    document: "products/{productId}",
  },
  async (event) => {
    const productId = event.params.productId;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    // ⛔ GUARD: Evitar loop recursivo
    // Si solo cambió metaSyncStatus o metaSyncAt, NO re-sincronizar
    if (before && after) {
      const beforeCopy = { ...before };
      const afterCopy = { ...after };
      delete beforeCopy.metaSyncStatus;
      delete beforeCopy.metaSyncAt;
      delete afterCopy.metaSyncStatus;
      delete afterCopy.metaSyncAt;

      if (JSON.stringify(beforeCopy) === JSON.stringify(afterCopy)) {
        console.log(`[CatalogSync] Solo cambió metaSyncStatus/metaSyncAt — ignorando para evitar loop`);
        return;
      }
    }

    // Producto eliminado o desactivado
    if (!after || after.deleted || !after.active) {
      if (before && before.active && !before.deleted) {
        console.log(`[CatalogSync] Producto ${productId} desactivado/borrado → eliminar de Meta`);
        await deleteProductFromMeta(productId);

        await db.collection("products").doc(productId).update({
          metaSyncStatus: "deleted",
          metaSyncAt: new Date().toISOString(),
        }).catch(() => {});
      }
      return;
    }

    // Producto creado o editado
    console.log(`[CatalogSync] Producto ${productId} cambiado → sincronizar con Meta`);
    const metaProduct = await mapProductToMeta(productId, after);
    const result = await upsertProductInMeta(metaProduct);

    await db.collection("products").doc(productId).update({
      metaSyncStatus: result ? "synced" : "error",
      metaSyncAt: new Date().toISOString(),
    }).catch(() => {});
  }
);

// ==============================================
// TRIGGER: Variante cambia (precio/stock)
// ==============================================
const onVariantChange = onDocumentWritten(
  {
    document: "products/{productId}/variants/{variantId}",
  },
  async (event) => {
    const productId = event.params.productId;
    const variantBefore = event.data?.before?.data();
    const variantAfter = event.data?.after?.data();

    const priceChanged = (variantBefore?.price || 0) !== (variantAfter?.price || 0);
    const stockChanged = (variantBefore?.stock || 0) !== (variantAfter?.stock || 0);

    if (!priceChanged && !stockChanged) return;

    console.log(`[CatalogSync] Variante de ${productId} cambió precio/stock → re-sync`);

    const productDoc = await db.collection("products").doc(productId).get();
    if (!productDoc.exists) return;

    const productData = productDoc.data();
    if (!productData.active || productData.deleted) return;

    const metaProduct = await mapProductToMeta(productId, productData);
    await upsertProductInMeta(metaProduct);

    await db.collection("products").doc(productId).update({
      metaSyncStatus: "synced",
      metaSyncAt: new Date().toISOString(),
    }).catch(() => {});
  }
);

module.exports = {
  onProductChange,
  onVariantChange,
  mapProductToMeta,
  upsertProductInMeta,
};
