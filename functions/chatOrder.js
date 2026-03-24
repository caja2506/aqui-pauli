const { db } = require("./utils");

// ==============================================
// CONFIGURACIÓN DE ENVÍO — lee de Firestore o usa defaults
// ==============================================
async function getShippingConfig() {
  try {
    const snap = await db.collection("settings").doc("shipping").get();
    if (snap.exists) {
      const data = snap.data();
      return {
        standardCost: data.standardCost || 2500,
        freeShippingThreshold: data.freeShippingThreshold || null,
        expressMultiplier: data.expressMultiplier || 2,
        backorderDepositPercent: data.backorderDepositPercent || 20,
      };
    }
  } catch (err) {
    console.warn("[ChatOrder] Error leyendo config de envío, usando defaults:", err.message);
  }
  // Defaults
  return {
    standardCost: 2500,
    freeShippingThreshold: null,
    expressMultiplier: 2,
    backorderDepositPercent: 20,
  };
}

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
          
          const itemVariantName = (item.variantName || item.variant || "").toLowerCase();
          let bestVariant = null;
          let anyVariant = null;

          for (const vDoc of varSnap.docs) {
            const v = vDoc.data();
            // Guardar cualquier variante como fallback (incluso bajo_pedido)
            if (!anyVariant) anyVariant = { id: vDoc.id, ...v };
            
            // Intentar match por nombre de variante
            if (itemVariantName && v.name && v.name.toLowerCase().includes(itemVariantName)) {
              bestVariant = { id: vDoc.id, ...v };
              break;
            }
            // Si no hay nombre, tomar la primera con stock o bajo_pedido
            if (!itemVariantName && (v.stock > 0 || v.supplyType === "bajo_pedido")) {
              bestVariant = { id: vDoc.id, ...v };
              break;
            }
          }
          matchedVariant = bestVariant || anyVariant;
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
    const shippingConfig = await getShippingConfig();
    const subtotal = resolvedItems.reduce((sum, i) => sum + i.lineTotal, 0);
    const shippingCost = (shippingConfig.freeShippingThreshold && subtotal >= shippingConfig.freeShippingThreshold)
      ? 0
      : shippingConfig.standardCost;

    // Detectar items bajo_pedido y calcular anticipo 20%
    const backorderItems = resolvedItems.filter(i => i.supplyType === "bajo_pedido");
    const hasBackorder = backorderItems.length > 0;
    let backorderDeposit = 0;
    let remainingTotal = 0;

    if (hasBackorder) {
      const depositPercent = shippingConfig.backorderDepositPercent / 100;
      backorderDeposit = Math.ceil(subtotal * depositPercent);
      remainingTotal = subtotal - backorderDeposit;
    }

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
      hasBackorder,
      backorderDeposit,
      remainingTotal: hasBackorder ? remainingTotal : 0,
      backorderDepositPercent: hasBackorder ? shippingConfig.backorderDepositPercent : 0,
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
      hasBackorder,
      backorderDeposit,
      remainingTotal: hasBackorder ? remainingTotal : 0,
      backorderDepositPercent: hasBackorder ? shippingConfig.backorderDepositPercent : 0,
      items: resolvedItems,
    };
  } catch (err) {
    console.error("Error creating chat order:", err);
    return { success: false, error: err.message };
  }
}

module.exports = { createChatOrder, modifyChatOrder, getShippingConfig };

// ==============================================
// MODIFICAR ORDEN EXISTENTE DESDE EL CHAT
// ==============================================
async function modifyChatOrder(contactId, orderData) {
  /*
    orderData esperado:
    {
      orderNumber: "AP-263282" (opcional, si no se da busca el último pedido),
      addItems: [{ productName, quantity }],
      removeItems: [{ productName }] (opcional)
    }
  */
  try {
    // Buscar la orden
    let orderDoc = null;

    if (orderData.orderNumber) {
      const snap = await db.collection("orders")
        .where("orderNumber", "==", orderData.orderNumber)
        .limit(1).get();
      if (!snap.empty) orderDoc = snap.docs[0];
    }

    // Si no se dio número, buscar la última orden del contacto
    if (!orderDoc && contactId) {
      const snap = await db.collection("orders")
        .where("uid", "==", contactId)
        .orderBy("createdAt", "desc")
        .limit(1).get();
      if (!snap.empty) orderDoc = snap.docs[0];
    }

    if (!orderDoc) {
      return { success: false, error: "No encontré un pedido para modificar" };
    }

    const order = orderDoc.data();
    const existingItems = order.itemsSummary || [];

    // Resolver nuevos items
    const newItems = [];
    for (const item of (orderData.addItems || [])) {
      const prodSnap = await db.collection("products")
        .where("active", "==", true).get();

      let matchedProduct = null;
      let matchedVariant = null;

      for (const pDoc of prodSnap.docs) {
        const p = pDoc.data();
        if (p.name && p.name.toLowerCase().includes((item.productName || "").toLowerCase())) {
          matchedProduct = { id: pDoc.id, ...p };
          const varSnap = await db.collection("products").doc(pDoc.id)
            .collection("variants").get();
          for (const vDoc of varSnap.docs) {
            const v = vDoc.data();
            if (v.stock > 0) {
              matchedVariant = { id: vDoc.id, ...v };
              break;
            }
          }
          break;
        }
      }

      if (!matchedProduct) {
        return { success: false, error: `No encontré "${item.productName}" en el catálogo` };
      }

      const price = matchedVariant?.price || matchedProduct.price || 0;
      const qty = item.quantity || 1;

      newItems.push({
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

    // Combinar items existentes + nuevos
    const allItems = [...existingItems, ...newItems];
    const subtotal = allItems.reduce((sum, i) => sum + (i.lineTotal || i.price * (i.quantity || 1)), 0);
    const shippingCost = order.shippingCost || 2500;
    const total = subtotal + shippingCost;
    const now = new Date().toISOString();

    const batch = db.batch();

    // Actualizar orden principal
    batch.update(orderDoc.ref, {
      itemsSummary: allItems,
      itemCount: allItems.reduce((sum, i) => sum + (i.quantity || 1), 0),
      subtotal,
      total,
      updatedAt: now,
      notes: `${order.notes || ""}\nModificado vía chat WhatsApp el ${now}`,
    });

    // Agregar nuevos items a sub-colección
    const existingItemCount = existingItems.length;
    newItems.forEach((item, index) => {
      const itemRef = orderDoc.ref.collection("items").doc(`item_${existingItemCount + index}`);
      batch.set(itemRef, item);
    });

    await batch.commit();

    console.log(`[ChatOrder] Modified order ${order.orderNumber} - added ${newItems.length} items`);
    return {
      success: true,
      orderId: orderDoc.id,
      orderNumber: order.orderNumber,
      total,
      subtotal,
      shippingCost,
      addedItems: newItems,
      allItems,
    };
  } catch (err) {
    console.error("Error modifying chat order:", err);
    return { success: false, error: err.message };
  }
}
