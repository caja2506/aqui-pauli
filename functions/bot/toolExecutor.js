// ==============================================
// TOOL EXECUTOR — Capa de tools/backend
// Consulta Firestore para datos reales. NUNCA inventa.
// ==============================================

const { db } = require("../utils");
const { getShippingConfig } = require("../chatOrder");

/**
 * Ejecutar una herramienta/tool solicitada por Gemini
 * @param {string} toolName — nombre de la tool
 * @param {Object} payload — datos enviados por Gemini
 * @param {Object} sessionContext — { contactId, phone, sessionId }
 * @returns {Object} — { success, data, error? }
 */
async function executeTool(toolName, payload, sessionContext) {
  const tools = {
    getProductCatalog,
    getProductBySku,
    checkStock,
    getCustomerProfile,
    saveCustomerAddress,
    createOrUpdateCart,
    createOrderDraft,
    getOrderStatus,
    handoffToHuman,
  };

  const toolFn = tools[toolName];
  if (!toolFn) {
    console.warn(`[ToolExecutor] Tool desconocida: ${toolName}`);
    return { success: false, error: `Tool "${toolName}" no existe` };
  }

  try {
    console.log(`[ToolExecutor] Ejecutando: ${toolName}`, JSON.stringify(payload || {}).substring(0, 200));
    const result = await toolFn(payload || {}, sessionContext);
    console.log(`[ToolExecutor] ${toolName} → success:${result.success}`);
    return result;
  } catch (err) {
    console.error(`[ToolExecutor] Error en ${toolName}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ==============================================
// TOOLS INDIVIDUALES
// ==============================================

/**
 * Buscar productos en el catálogo, opcionalmente filtrados
 */
async function getProductCatalog({ query, limit: maxResults } = {}) {
  try {
    let ref = db.collection("products").where("active", "==", true);

    // Si hay query, traemos más documentos para filtrar en memoria
    // (Firestore no tiene full-text search)
    const fetchLimit = query ? 100 : (maxResults || 15);
    const snap = await ref.limit(fetchLimit).get();
    if (snap.empty) return { success: true, data: { products: [], message: "No hay productos disponibles." } };

    const products = [];
    for (const doc of snap.docs) {
      const p = doc.data();
      if (p.deleted) continue;

      // Si hay query, filtrar ANTES de cargar variantes (más eficiente)
      if (query) {
        const q = query.toLowerCase();
        const nameMatch = (p.name || "").toLowerCase().includes(q);
        const catMatch = (p.category || "").toLowerCase().includes(q);
        const subCatMatch = (p.subcategory || "").toLowerCase().includes(q);
        const tagMatch = (p.tags || []).some(t => (t || "").toLowerCase().includes(q));
        if (!nameMatch && !catMatch && !subCatMatch && !tagMatch) continue;
      }

      const variantsSnap = await db.collection("products").doc(doc.id)
        .collection("variants").limit(5).get();

      const variants = variantsSnap.docs
        .map(v => {
          const vd = v.data();
          if (vd.active === false) return null;
          const attrs = vd.attributes || vd;
          const supplyType = attrs.supplyType || vd.supplyType || "stock_propio";
          const stock = attrs.stock || vd.stock || 0;
          let status = attrs.commercialStatus || (stock > 0 ? "disponible" : "agotado");
          if (status === "agotado" && supplyType === "bajo_pedido") {
            status = "disponible_bajo_pedido";
          }
          return {
            id: v.id,
            name: attrs.name || vd.name || "",
            price: attrs.price || vd.price || p.basePrice || 0,
            stock,
            status,
            supplyType,
          };
        })
        .filter(Boolean);

      products.push({
        id: doc.id,
        name: p.name,
        category: p.category || "",
        basePrice: p.basePrice || 0,
        imageUrl: p.imageUrl || p.images?.[0] || "",
        variants,
      });
    }

    // Formatear para contexto
    const formatted = products.map(p => {
      const varStr = p.variants.map(v =>
        `  - ${v.name}: ₡${v.price.toLocaleString()}, ${v.status}${v.supplyType === "bajo_pedido" ? " (bajo pedido)" : ""}`
      ).join("\n");
      return `${p.name} (${p.category}):\n${varStr || "  Sin variantes"}`;
    }).join("\n\n");

    return {
      success: true,
      data: {
        products,
        formatted,
        count: products.length,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Obtener un producto específico con variantes
 */
async function getProductBySku({ productName, productId } = {}) {
  try {
    let product = null;
    let productDoc = null;

    if (productId) {
      const snap = await db.collection("products").doc(productId).get();
      if (snap.exists) {
        product = snap.data();
        productDoc = snap;
      }
    }

    // Buscar por nombre si no hay ID — búsqueda fuzzy
    if (!product && productName) {
      const snap = await db.collection("products")
        .where("active", "==", true)
        .get();

      // Normalizar el nombre buscado: quitar info de variante (después de " - ")
      const searchName = productName.toLowerCase().split(" - ")[0].trim();
      const searchWords = searchName.split(/\s+/).filter(w => w.length > 2);

      let bestMatch = null;
      let bestScore = 0;

      for (const doc of snap.docs) {
        const p = doc.data();
        if (!p.name) continue;
        const pName = p.name.toLowerCase();

        // Match exacto por inclusión
        if (pName.includes(searchName) || searchName.includes(pName)) {
          product = p;
          productDoc = doc;
          break;
        }

        // Fuzzy: contar palabras coincidentes
        const pWords = pName.split(/\s+/);
        const matchCount = searchWords.filter(w => pWords.some(pw => pw.includes(w) || w.includes(pw))).length;
        const score = matchCount / Math.max(searchWords.length, 1);

        if (score > bestScore && score >= 0.5) {
          bestScore = score;
          bestMatch = { p, doc };
        }
      }

      // Usar el mejor match fuzzy si no hubo match exacto
      if (!product && bestMatch) {
        product = bestMatch.p;
        productDoc = bestMatch.doc;
        console.log(`[ToolExecutor] getProductBySku fuzzy match: "${productName}" → "${product.name}" (score: ${bestScore.toFixed(2)})`);
      }
    }

    if (!product) {
      return { success: false, error: `Producto "${productName || productId}" no encontrado en el catálogo` };
    }

    // Cargar variantes
    const variantsSnap = await db.collection("products").doc(productDoc.id)
      .collection("variants").get();

    const variants = variantsSnap.docs.map(v => {
      const vd = v.data();
      const attrs = vd.attributes || vd;
      return {
        id: v.id,
        name: attrs.name || vd.name || "",
        price: attrs.price || vd.price || product.basePrice || 0,
        stock: attrs.stock || vd.stock || 0,
        supplyType: attrs.supplyType || vd.supplyType || "stock_propio",
        active: vd.active !== false,
      };
    }).filter(v => v.active);

    return {
      success: true,
      data: {
        id: productDoc.id,
        name: product.name,
        category: product.category || "",
        basePrice: product.basePrice || 0,
        imageUrl: product.imageUrl || product.images?.[0] || "",
        variants,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Verificar stock de un producto/variante
 */
async function checkStock({ productId, variantId } = {}) {
  try {
    if (!productId) return { success: false, error: "productId requerido" };

    if (variantId) {
      const varSnap = await db.collection("products").doc(productId)
        .collection("variants").doc(variantId).get();
      if (!varSnap.exists) return { success: false, error: "Variante no encontrada" };

      const vd = varSnap.data();
      const attrs = vd.attributes || vd;
      const stock = attrs.stock || vd.stock || 0;
      const supplyType = attrs.supplyType || vd.supplyType || "stock_propio";
      const available = stock > 0 || supplyType === "bajo_pedido";

      return {
        success: true,
        data: {
          stock,
          supplyType,
          available,
          message: available
            ? (stock > 0 ? `${stock} unidades disponibles` : "Disponible bajo pedido (anticipo 20%, 15-20 días hábiles)")
            : "Agotado",
        },
      };
    }

    // Si no hay variantId, verificar todas las variantes
    const varSnap = await db.collection("products").doc(productId)
      .collection("variants").get();

    const variantStocks = varSnap.docs.map(v => {
      const vd = v.data();
      const attrs = vd.attributes || vd;
      return {
        id: v.id,
        name: attrs.name || vd.name || "",
        stock: attrs.stock || vd.stock || 0,
        supplyType: attrs.supplyType || vd.supplyType || "stock_propio",
      };
    });

    return {
      success: true,
      data: {
        variants: variantStocks,
        anyAvailable: variantStocks.some(v => v.stock > 0 || v.supplyType === "bajo_pedido"),
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Obtener perfil del cliente
 */
async function getCustomerProfile(_, { contactId } = {}) {
  try {
    if (!contactId) return { success: false, error: "contactId requerido" };

    const snap = await db.collection("crm_contacts").doc(contactId).get();
    if (!snap.exists) return { success: false, error: "Cliente no encontrado" };

    const c = snap.data();
    return {
      success: true,
      data: {
        name: c.displayName || "",
        phone: c.phone || "",
        email: c.email || "",
        totalOrders: c.totalOrders || 0,
        funnelStage: c.funnelStage || "",
        lastAddress: c.lastAddress || null,
        preferredPaymentMethod: c.preferredPaymentMethod || "",
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Guardar dirección del cliente
 */
async function saveCustomerAddress({ address, provincia, canton, distrito, señas }, { contactId } = {}) {
  try {
    if (!contactId) return { success: false, error: "contactId requerido" };

    const addressData = {
      provincia: provincia || "",
      canton: canton || "",
      distrito: distrito || "",
      señas: señas || address || "",
    };

    await db.collection("crm_contacts").doc(contactId).update({
      lastAddress: addressData,
      updatedAt: new Date().toISOString(),
    });

    return { success: true, data: { address: addressData } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Crear o actualizar carrito de la sesión
 */
async function createOrUpdateCart({ items } = {}, { sessionId } = {}) {
  try {
    if (!items || items.length === 0) {
      return { success: false, error: "No hay items para el carrito" };
    }

    // Validar items contra catálogo
    const validatedItems = [];
    for (const item of items) {
      const productResult = await getProductBySku({ productName: item.productName, productId: item.productId });
      if (!productResult.success) {
        return { success: false, error: `Producto "${item.productName}" no encontrado en el catálogo` };
      }

      const product = productResult.data;
      // Buscar variante con precio real
      let price = product.basePrice;
      let variantId = "";
      let variantName = "Única";

      if (product.variants.length > 0) {
        const variant = product.variants[0]; // Tomar primera variante disponible
        price = variant.price || price;
        variantId = variant.id;
        variantName = variant.name;
      }

      validatedItems.push({
        productId: product.id,
        productName: product.name,
        variantId,
        variantName,
        price,
        quantity: item.quantity || 1,
        lineTotal: price * (item.quantity || 1),
      });
    }

    const subtotal = validatedItems.reduce((sum, i) => sum + i.lineTotal, 0);

    // Leer config de envío del sistema
    const shippingConfig = await getShippingConfig();
    const shippingCost = (shippingConfig.freeShippingThreshold && subtotal >= shippingConfig.freeShippingThreshold)
      ? 0
      : shippingConfig.standardCost;

    // Detectar bajo_pedido
    const hasBackorder = validatedItems.some(i => i.supplyType === "bajo_pedido");
    let backorderDeposit = 0;
    if (hasBackorder) {
      backorderDeposit = Math.ceil(subtotal * (shippingConfig.backorderDepositPercent / 100));
    }

    // Actualizar carrito en sesión si hay sessionId
    if (sessionId && !sessionId.startsWith("temp_")) {
      await db.collection("bot_sessions").doc(sessionId).update({
        cartSnapshot: { items: validatedItems, subtotal },
        updatedAt: new Date().toISOString(),
      });
    }

    return {
      success: true,
      data: {
        items: validatedItems,
        subtotal,
        shippingCost,
        total: subtotal + shippingCost,
        hasBackorder,
        backorderDeposit,
        backorderDepositPercent: hasBackorder ? shippingConfig.backorderDepositPercent : 0,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Crear borrador de orden — reutiliza lógica de chatOrder.js
 */
async function createOrderDraft(payload, { contactId, phone } = {}) {
  try {
    const { createChatOrder } = require("../chatOrder");

    const orderData = {
      items: payload.items || [],
      customerName: payload.customerName || "",
      customerPhone: payload.customerPhone || phone || "",
      address: payload.address || "",
      paymentMethod: payload.paymentMethod || "sinpe",
      customerEmail: payload.customerEmail || "",
    };

    const result = await createChatOrder(contactId, orderData);
    return {
      success: result.success,
      data: result.success ? {
        orderNumber: result.orderNumber,
        orderId: result.orderId,
        total: result.total,
        subtotal: result.subtotal,
        shippingCost: result.shippingCost,
        hasBackorder: result.hasBackorder || false,
        backorderDeposit: result.backorderDeposit || 0,
        remainingTotal: result.remainingTotal || 0,
        backorderDepositPercent: result.backorderDepositPercent || 0,
        items: result.items,
      } : null,
      error: result.error || null,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Consultar estado de una orden
 */
async function getOrderStatus({ orderNumber } = {}) {
  try {
    if (!orderNumber) return { success: false, error: "orderNumber requerido" };

    const snap = await db.collection("orders")
      .where("orderNumber", "==", orderNumber.toUpperCase())
      .limit(1)
      .get();

    if (snap.empty) return { success: false, error: `Orden ${orderNumber} no encontrada` };

    const order = snap.docs[0].data();
    const STATUS_LABELS = {
      pendiente_pago: "Pendiente de pago",
      pagado: "Pagado",
      preparando: "En preparación",
      enviado: "Enviado",
      entregado: "Entregado",
      cancelado: "Cancelado",
      verificando: "Verificando pago",
      revision_manual: "En revisión",
      revision_humana: "En revisión",
    };

    return {
      success: true,
      data: {
        orderNumber: order.orderNumber,
        status: STATUS_LABELS[order.status] || order.status,
        rawStatus: order.status,
        total: order.total || 0,
        paymentStatus: order.paymentStatus || "",
        items: (order.itemsSummary || []).map(i => ({
          productName: i.productName,
          quantity: i.quantity,
          price: i.price,
        })),
        createdAt: order.createdAt || "",
        trackingNumber: order.trackingNumber || "",
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Escalar a humano
 */
async function handoffToHuman({ reason } = {}, { contactId } = {}) {
  try {
    if (contactId) {
      await db.collection("crm_contacts").doc(contactId).update({
        unresolvedAttentionRequired: true,
        unresolvedReason: reason || "Escalamiento desde bot",
        updatedAt: new Date().toISOString(),
      });
    }

    return {
      success: true,
      data: {
        message: "Conversación escalada a un agente humano",
        reason: reason || "Solicitud del cliente",
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  executeTool,
  // Exportar tools individuales para uso directo si es necesario
  getProductCatalog,
  getProductBySku,
  checkStock,
  getCustomerProfile,
  saveCustomerAddress,
  createOrUpdateCart,
  createOrderDraft,
  getOrderStatus,
  handoffToHuman,
};
