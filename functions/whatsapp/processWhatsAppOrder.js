// ==============================================
// Procesar carrito de WhatsApp → Orden en Firestore
// Cuando el cliente envía su carrito desde el catálogo WA
// ==============================================
const { getFirestore } = require("firebase-admin/firestore");
const { createChatOrder } = require("../chatOrder");

const db = getFirestore();

/**
 * Procesa un mensaje tipo "order" de WhatsApp
 * El cliente armó un carrito en el catálogo nativo de WA y lo envió
 *
 * Estructura del mensaje:
 * {
 *   type: "order",
 *   order: {
 *     catalog_id: "XXXXX",
 *     product_items: [
 *       { product_retailer_id: "firestore_id", quantity: 2, item_price: 13850000, currency: "CRC" }
 *     ],
 *     text: "Nota del cliente"
 *   }
 * }
 */
async function processWhatsAppOrder(message, phone, contactId, contact) {
  const order = message.order;
  if (!order || !order.product_items || order.product_items.length === 0) {
    console.warn("[WAOrder] Orden sin productos");
    return { success: false, error: "Orden vacía" };
  }

  console.log(`[WAOrder] 🛒 Carrito recibido de ${phone}: ${order.product_items.length} items`);

  // Resolver cada item contra Firestore (NUNCA confiar en precios de Meta)
  const resolvedItems = [];
  const errors = [];

  for (const item of order.product_items) {
    const productId = item.product_retailer_id;
    const quantity = item.quantity || 1;

    try {
      // Buscar producto en Firestore
      const productDoc = await db.collection("products").doc(productId).get();

      if (!productDoc.exists) {
        errors.push(`Producto ${productId} no encontrado`);
        continue;
      }

      const productData = productDoc.data();

      if (!productData.active || productData.deleted) {
        errors.push(`${productData.name || productId} ya no está disponible`);
        continue;
      }

      // Buscar variante con stock
      const variantsSnap = await db.collection("products").doc(productId)
        .collection("variants").get();

      let bestVariant = null;
      let totalStock = 0;

      for (const vDoc of variantsSnap.docs) {
        const v = vDoc.data();
        if (v.active !== false) {
          totalStock += (v.stock || 0);
          if (!bestVariant && v.stock > 0) {
            bestVariant = { id: vDoc.id, ...v };
          }
        }
      }

      // Precio real de Firestore (NO el de Meta)
      const realPrice = bestVariant?.price || productData.basePrice || 0;

      if (totalStock < quantity) {
        errors.push(`${productData.name}: solo hay ${totalStock} en stock (pediste ${quantity})`);
        // Aún así agregar con la cantidad disponible
        if (totalStock > 0) {
          resolvedItems.push({
            productName: productData.name,
            productId: productId,
            variantId: bestVariant?.id || "",
            price: realPrice,
            quantity: totalStock,
            note: `Ajustado de ${quantity} a ${totalStock} por stock`,
          });
        }
        continue;
      }

      resolvedItems.push({
        productName: productData.name,
        productId: productId,
        variantId: bestVariant?.id || "",
        price: realPrice,
        quantity: quantity,
      });
    } catch (err) {
      console.error(`[WAOrder] Error procesando ${productId}:`, err.message);
      errors.push(`Error con producto ${productId}`);
    }
  }

  if (resolvedItems.length === 0) {
    return {
      success: false,
      error: errors.length > 0
        ? `No pudimos procesar tu carrito: ${errors.join(". ")}`
        : "No hay productos válidos en tu carrito",
    };
  }

  // Crear la orden usando createChatOrder existente
  const orderData = {
    items: resolvedItems,
    customerName: contact?.displayName || "",
    customerPhone: phone,
    customerEmail: contact?.email || "",
    address: contact?.lastAddress
      ? [contact.lastAddress.provincia, contact.lastAddress.canton, contact.lastAddress.distrito, contact.lastAddress.señas]
          .filter(Boolean).join(", ")
      : "",
    paymentMethod: contact?.preferredPaymentMethod || "sinpe",
  };

  const result = await createChatOrder(contactId, orderData);

  if (result.success) {
    console.log(`[WAOrder] ✅ Orden ${result.orderNumber} creada desde carrito WA`);
  }

  return {
    ...result,
    stockWarnings: errors.length > 0 ? errors : null,
    source: "whatsapp_catalog_cart",
  };
}

module.exports = { processWhatsAppOrder };
