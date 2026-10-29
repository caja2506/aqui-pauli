// ==============================================
// Cálculo de totales de un pedido en el SERVIDOR (CRC), a partir de los
// precios en Firestore. Nunca se confía en precios/envío enviados por el cliente.
// Reutilizable por cualquier pasarela (PayPal, Tilopay…).
// ==============================================

// Mantener sincronizado con src/utils/constants.js y src/services/shippingService.js
const GAM_CANTONES = [
  "San José", "Escazú", "Desamparados", "Goicoechea", "Alajuelita",
  "Vásquez de Coronado", "Tibás", "Moravia", "Montes de Oca", "Curridabat", "Santa Ana",
  "Alajuela", "Atenas", "Poás", "Grecia",
  "Cartago", "Paraíso", "La Unión", "Oreamuno", "El Guarco", "Alvarado",
  "Heredia", "Barva", "Santo Domingo", "Santa Bárbara", "San Rafael",
  "San Isidro", "Belén", "Flores", "San Pablo",
];
const EXPRESS_CANTONES = ["Grecia"];
const DEFAULT_SHIPPING_PRICES = { normalGAM: 3500, normalOutside: 5500, expressGrecia: 2000 };

const norm = (s) => String(s || "").trim().toLowerCase();
const inList = (list, canton) => !!canton && list.some((c) => norm(c) === norm(canton));

function shippingCostCRC(prices, canton, shippingType = "normal") {
  const p = { ...DEFAULT_SHIPPING_PRICES, ...(prices || {}) };
  if (shippingType === "express" && inList(EXPRESS_CANTONES, canton)) return Number(p.expressGrecia);
  if (inList(GAM_CANTONES, canton)) return Number(p.normalGAM);
  return Number(p.normalOutside);
}

/**
 * @param db Firestore admin
 * @param {{productId,variantId,quantity}[]} items
 * @param {{canton:string, shippingType?:string}} ship
 * @returns {{lines, subtotal, shippingCost, total}} en CRC enteros
 */
async function computeTotalsCRC(db, items, ship) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    throw new Error("Items inválidos");
  }
  const lines = [];
  for (const it of items) {
    const qty = Number(it.quantity);
    if (!it.productId || !it.variantId || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw new Error("Item inválido");
    }
    const pRef = db.collection("products").doc(String(it.productId));
    const [pSnap, vSnap] = await Promise.all([pRef.get(), pRef.collection("variants").doc(String(it.variantId)).get()]);
    if (!pSnap.exists || !vSnap.exists) throw new Error("Producto no encontrado");
    const p = pSnap.data();
    const v = vSnap.data();
    if (p.active === false || p.deleted || v.active === false) throw new Error(`Producto no disponible: ${p.name || it.productId}`);
    const price = Math.round(Number(v.price || p.basePrice));
    if (!(price > 0)) throw new Error(`Producto sin precio: ${p.name || it.productId}`);
    lines.push({
      productId: String(it.productId), variantId: String(it.variantId), quantity: qty,
      unitPrice: price, lineTotal: price * qty, name: p.name || "",
    });
  }
  let prices = null;
  try {
    const s = await db.collection("config").doc("shipping").get();
    if (s.exists) prices = s.data();
  } catch (e) {
    console.warn("[pricing] config/shipping:", e.message);
  }
  const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
  const shippingCost = Math.round(shippingCostCRC(prices, ship?.canton, ship?.shippingType));
  return { lines, subtotal, shippingCost, total: subtotal + shippingCost };
}

module.exports = { computeTotalsCRC, shippingCostCRC, GAM_CANTONES, EXPRESS_CANTONES };
