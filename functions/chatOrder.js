const { db } = require("./utils");

// ==============================================
// GENERAR NÚMERO DE ORDEN (AP-XXXXXX)
// ==============================================
function generateOrderNumber() {
  const num = Math.floor(100000 + Math.random() * 900000);
  return `AP-${num}`;
}

// ==============================================
// CREAR ORDEN DESDE EL CHAT
// ==============================================
async function createChatOrder(contactId, orderData) {
  /*
    orderData esperado de Gemini:
    {
      items: [{ productName, variantName, price, quantity, productId?, variantId? }],
      customerName: "Pamela Rojas",
      customerPhone: "84967389",
      address: "San José, Escazú",
      paymentMethod: "sinpe"
    }
  */
  try {
    // Validar que hay items
    if (!orderData.items || orderData.items.length === 0) {
      return { success: false, error: "No hay productos en el pedido" };
    }

    // Buscar productos reales del catálogo para validar precios
    const resolvedItems = [];
    for (const item of orderData.items) {
      let matchedProduct = null;
      let matchedVariant = null;

      // Buscar por nombre del producto
      const prodSnap = await db.collection("products")
        .where("active", "==", true)
        .get();

      for (const pDoc of prodSnap.docs) {
        const p = pDoc.data();
        if (p.name && p.name.toLowerCase().includes((item.productName || "").toLowerCase())) {
          matchedProduct = { id: pDoc.id, ...p };

          // Buscar variante
          const varSnap = await db.collection("products").doc(pDoc.id)
            .collection("variants").get();
          
          for (const vDoc of varSnap.docs) {
            const v = vDoc.data();
            if (v.stock > 0) {
              matchedVariant = { id: vDoc.id, ...v };
              break; // Tomar la primera variante con stock
            }
          }
          break;
        }
      }

      if (!matchedProduct) {
        return { success: false, error: `No encontré "${item.productName}" en el catálogo` };
      }

      const price = matchedVariant?.price || matchedProduct.price || item.price || 0;
      const qty = item.quantity || 1;

      resolvedItems.push({
        productId: matchedProduct.id,
        variantId: matchedVariant?.id || "",
        productName: matchedProduct.name,
        variantName: matchedVariant?.name || "Única",
        imageUrl: matchedProduct.imageUrl || matchedProduct.images?.[0] || "",
        price,
        quantity: qty,
        supplyType: matchedVariant?.supplyType || "stock_propio",
        lineTotal: price * qty,
      });
    }

    // Calcular totales
    const subtotal = resolvedItems.reduce((sum, i) => sum + i.lineTotal, 0);
    const shippingCost = 2500; // Envío estándar
    const total = subtotal + shippingCost;

    // Generar orden
    const orderId = db.collection("orders").doc().id;
    const orderNumber = generateOrderNumber();
    const now = new Date().toISOString();

    const batch = db.batch();

    // Documento principal
    const orderRef = db.collection("orders").doc(orderId);
    batch.set(orderRef, {
      orderNumber,
      uid: contactId || "",
      customerName: orderData.customerName || "Cliente WhatsApp",
      customerEmail: orderData.customerEmail || "",
      customerPhone: orderData.customerPhone || "",
      shippingAddress: {
        provincia: "",
        canton: "",
        distrito: "",
        codigoPostal: "",
        señas: orderData.address || "",
      },
      subtotal,
      shippingCost,
      shippingType: "normal",
      total,
      paymentMethod: orderData.paymentMethod || "sinpe",
      paymentPhone: "",
      paymentStatus: "pendiente",
      paymentProofUrl: "",
      hasBackorder: false,
      backorderDeposit: 0,
      status: "pendiente_pago",
      source: "whatsapp_chat",
      notes: `Pedido creado vía chat WhatsApp`,
      trackingNumber: "",
      trackingUrl: "",
      itemsSummary: resolvedItems.map(i => ({
        productId: i.productId,
        variantId: i.variantId,
        productName: i.productName,
        variantName: i.variantName,
        imageUrl: i.imageUrl,
        price: i.price,
        quantity: i.quantity,
        supplyType: i.supplyType,
        lineTotal: i.lineTotal,
      })),
      itemCount: resolvedItems.reduce((sum, i) => sum + i.quantity, 0),
      createdAt: now,
      updatedAt: now,
    });

    // Sub-colección de items
    resolvedItems.forEach((item, index) => {
      const itemRef = db.collection("orders").doc(orderId).collection("items").doc(`item_${index}`);
      batch.set(itemRef, item);
    });

    // Actualizar CRM
    if (contactId) {
      const crmRef = db.collection("crm_contacts").doc(contactId);
      batch.set(crmRef, {
        displayName: orderData.customerName || undefined,
        phone: orderData.customerPhone || undefined,
        funnelStage: "comprador",
        lastOrderId: orderId,
        lastOrderDate: now,
        updatedAt: now,
      }, { merge: true });
    }

    await batch.commit();

    console.log(`[ChatOrder] Created order ${orderNumber} (${orderId}) for ${contactId}`);
    return {
      success: true,
      orderId,
      orderNumber,
      total,
      subtotal,
      shippingCost,
      items: resolvedItems,
    };
  } catch (err) {
    console.error("Error creating chat order:", err);
    return { success: false, error: err.message };
  }
}

module.exports = { createChatOrder };
