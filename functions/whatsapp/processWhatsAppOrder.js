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
    const retailerId = item.product_retailer_id;
    const quantity = item.quantity || 1;

    try {
      // ==============================================
      // RESOLVER ID: Meta envía IDs compuestos "productId_variantId"
      // (creados en catalogSync.js mapProductToMeta)
      // Si no tiene "_", es un producto sin variantes (ID directo)
      // ==============================================
      let realProductId = retailerId;
      let targetVariantId = null;

      // Intentar primero con el ID directo (producto sin variantes)
      let productDoc = await db.collection("products").doc(retailerId).get();

      if (!productDoc.exists) {
        // No encontrado → probablemente es un ID compuesto "productId_variantId"
        // Buscar el separador "_" — el productId de Firestore puede tener 20 chars
        const underscoreIdx = retailerId.indexOf("_");
        if (underscoreIdx > 0) {
          realProductId = retailerId.substring(0, underscoreIdx);
          targetVariantId = retailerId.substring(underscoreIdx + 1);
          console.log(`[WAOrder] ID compuesto detectado: producto=${realProductId}, variante=${targetVariantId}`);
          productDoc = await db.collection("products").doc(realProductId).get();
        }
      }

      if (!productDoc.exists) {
        console.warn(`[WAOrder] Producto no encontrado: retailerId=${retailerId}, realProductId=${realProductId}`);
        errors.push(`Producto ${retailerId} no encontrado`);
        continue;
      }

      const productData = productDoc.data();
      const resolvedProductId = productDoc.id;

      if (!productData.active || productData.deleted) {
        errors.push(`${productData.name || resolvedProductId} ya no está disponible`);
        continue;
      }

      // Buscar variantes
      const variantsSnap = await db.collection("products").doc(resolvedProductId)
        .collection("variants").get();

      let bestVariant = null;
      let totalStock = 0;

      for (const vDoc of variantsSnap.docs) {
        const v = vDoc.data();
        if (v.active !== false) {
          totalStock += (v.stock || 0);
          // Priorizar la variante específica que pidió el cliente
          if (targetVariantId && vDoc.id === targetVariantId) {
            bestVariant = { id: vDoc.id, ...v };
          } else if (!bestVariant && !targetVariantId && v.stock > 0) {
            bestVariant = { id: vDoc.id, ...v };
          }
        }
      }

      // Si la variante target no se encontró, tomar la primera con stock
      if (!bestVariant) {
        for (const vDoc of variantsSnap.docs) {
          const v = vDoc.data();
          if (v.active !== false && v.stock > 0) {
            bestVariant = { id: vDoc.id, ...v };
            break;
          }
        }
      }

      // Precio real de Firestore (NO el de Meta)
      const realPrice = bestVariant?.price || productData.basePrice || 0;
      const variantName = bestVariant?.name || bestVariant?.attributes?.name || "";

      console.log(`[WAOrder] ✅ Producto resuelto: ${productData.name} ${variantName ? `(${variantName})` : ""} — ₡${realPrice} x${quantity}`);

      // Verificar si el producto es bajo pedido (se puede encargar sin stock)
      const isBajoPedido = productData.supplyType === "bajo_pedido" ||
        (bestVariant?.supplyType === "bajo_pedido");

      if (totalStock < quantity && !isBajoPedido) {
        errors.push(`${productData.name}: solo hay ${totalStock} en stock (pediste ${quantity})`);
        // Aún así agregar con la cantidad disponible
        if (totalStock > 0) {
          resolvedItems.push({
            productName: productData.name,
            productId: resolvedProductId,
            variantId: bestVariant?.id || "",
            price: realPrice,
            quantity: totalStock,
            note: `Ajustado de ${quantity} a ${totalStock} por stock`,
          });
        }
        continue;
      }

      // Producto bajo pedido con 0 stock → permitir con nota
      if (isBajoPedido && totalStock < quantity) {
        resolvedItems.push({
          productName: productData.name,
          productId: resolvedProductId,
          variantId: bestVariant?.id || "",
          price: realPrice,
          quantity: quantity,
          supplyType: "bajo_pedido",
          note: "Producto bajo pedido — anticipo 20%, entrega 15-20 días hábiles",
        });
        continue;
      }

      resolvedItems.push({
        productName: productData.name,
        productId: resolvedProductId,
        variantId: bestVariant?.id || "",
        price: realPrice,
        quantity: quantity,
      });
    } catch (err) {
      console.error(`[WAOrder] Error procesando ${retailerId}:`, err.message);
      errors.push(`Error con producto ${retailerId}`);
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
