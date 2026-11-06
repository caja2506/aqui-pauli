// Prices and fulfillment fields come from the catalog, never from checkout input.
// All monetary arithmetic uses integer CRC centavos.
const { parseMinorCRC, minorToCRC } = require("./paymentMoney");
const { normalizeInventoryStock } = require("./inventoryStock");
const { isSaleDecant, decantDelivery, MINIMUM_MESSAGE } = require("./decantSale.mjs");
const { minimumCatalogPrice, maximumProductQuantity, isFullPerfume, availableQuantity } = require("./catalogSafety.mjs");

const GAM_CANTONES = [
  "San José", "Escazú", "Desamparados", "Goicoechea", "Alajuelita",
  "Vásquez de Coronado", "Tibás", "Moravia", "Montes de Oca", "Curridabat", "Santa Ana",
  "Alajuela", "Atenas", "Poás", "Grecia",
  "Cartago", "Paraíso", "La Unión", "Oreamuno", "El Guarco", "Alvarado",
  "Heredia", "Barva", "Santo Domingo", "Santa Bárbara", "San Rafael",
  "San Isidro", "Belén", "Flores", "San Pablo",
];
const EXPRESS_CANTONES = ["Grecia"];

class PricingError extends Error {
  constructor(reason, message, lineIndex) {
    super(message);
    this.name = "PricingError";
    this.reason = reason;
    if (lineIndex !== undefined) this.lineIndex = lineIndex;
  }
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function safeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PricingError("AMOUNT_OUT_OF_RANGE", `${label} inválido`);
  }
  return value;
}

function catalogText(value, max = 300) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * @param {object} db Firestore Admin instance
 * @param {{productId:string,variantId:string,quantity:number}[]} items
 * @param {{canton?:string,shippingType?:string}} ship
 * @param {{transaction?:object}} options Pass the current Firestore transaction.
 * @returns {Promise<{lines:object[],subtotal:number,shippingCost:number,total:number,
 *   subtotalMinor:number,shippingCostMinor:number,totalMinor:number}>}
 *
 * This function validates/prices a cart but does NOT reserve or consume stock.
 * The caller must check stock - reservedStock and reserve it atomically. Checking
 * availability here would incorrectly exclude an existing order's own reservation.
 * When transaction is present, every catalog read belongs to that transaction.
 */
async function computeTotalsCRC(db, items, ship, { transaction, previewDelivery = false } = {}) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    throw new PricingError("INVALID_ITEM_COUNT", "Items inválidos: se requieren entre 1 y 50 líneas");
  }
  if (transaction && typeof transaction.get !== "function") throw new Error("Transacción inválida");
  const read = (ref) => transaction ? transaction.get(ref) : ref.get();
  const seen = new Set();
  // Validate every line before doing any reads. Never coerce quantity or ids.
  for (const [lineIndex, item] of items.entries()) {
    if (!item || typeof item !== "object" || !validId(item.productId) || !validId(item.variantId)
      || typeof item.quantity !== "number" || !Number.isInteger(item.quantity)
      || item.quantity < 1 || item.quantity > 99) {
      throw new PricingError("INVALID_ITEM", "Item inválido: id o cantidad no válidos", lineIndex);
    }
    const identity = JSON.stringify([item.productId, item.variantId]);
    if (seen.has(identity)) throw new PricingError("DUPLICATE_VARIANT", "Variante duplicada: agrupá las cantidades en una sola línea", lineIndex);
    seen.add(identity);
  }

  const lines = [];
  const productQuantities = new Map();
  let subtotalMinor = 0;
  let onlyDecants = true;
  for (const [lineIndex, item] of items.entries()) {
    const productRef = db.collection("products").doc(item.productId);
    const variantRef = productRef.collection("variants").doc(item.variantId);
    const [productSnap, variantSnap] = await Promise.all([read(productRef), read(variantRef)]);
    if (!productSnap.exists || !variantSnap.exists) throw new PricingError("CATALOG_NOT_FOUND", "Producto o variante no encontrado", lineIndex);
    const product = productSnap.data();
    const variant = variantSnap.data();
    if (!product || !variant || product.active === false || product.deleted
      || variant.active === false || variant.deleted) {
      throw new PricingError("CATALOG_UNAVAILABLE", `Producto no disponible: ${catalogText(product?.name) || item.productId}`, lineIndex);
    }

    const decant = isSaleDecant(product);
    const productQuantity = (productQuantities.get(item.productId) || 0) + item.quantity;
    productQuantities.set(item.productId, productQuantity);
    if (productQuantity > maximumProductQuantity(product)) {
      throw new PricingError("CATALOG_QUANTITY_LIMIT", "Por el momento solo podés comprar una unidad de cada colonia.", lineIndex);
    }
    if (!decant) onlyDecants = false;
    const supplyType = variant.supplyType ?? product.supplyType ?? "stock_propio";
    if (!["stock_propio", "bajo_pedido"].includes(supplyType)) throw new PricingError("CATALOG_SUPPLY_INVALID", "Abastecimiento del catálogo inválido", lineIndex);
    if (isFullPerfume(product) && supplyType !== "stock_propio") {
      throw new PricingError("CATALOG_UNAVAILABLE", "Esta colonia no está disponible. No se aceptan pedidos sin existencias.", lineIndex);
    }
    if (!["disponible", "bajo_pedido"].includes(variant.commercialStatus ?? "disponible")) {
      throw new PricingError("CATALOG_UNAVAILABLE", "Este producto no está disponible.", lineIndex);
    }
    if (decant && (supplyType !== "stock_propio" || (variant.commercialStatus ?? "disponible") !== "disponible")) {
      throw new PricingError("CATALOG_UNAVAILABLE", "Este tamaño de decant no está disponible para entrega inmediata.", lineIndex);
    }
    // A stale reservation counter must not break a quote. Physical stock still
    // validates strictly; callers normalize again inside their stock transaction.
    try { normalizeInventoryStock(variant, { context: "pricing" }); }
    catch (error) {
      if (error.code !== "INVENTORY_STOCK_INVALID") throw error;
      throw new PricingError("CATALOG_STOCK_INVALID", error.message, lineIndex);
    }

    // A configured zero/negative/malformed variant price is an error. Only an
    // absent value inherits basePrice; falsy values must not hide a catalog error.
    const rawPrice = variant.price === undefined || variant.price === null || variant.price === ""
      ? product.basePrice : variant.price;
    let unitPriceMinor;
    try { unitPriceMinor = parseMinorCRC(rawPrice); }
    catch { throw new PricingError("CATALOG_PRICE_INVALID", `Producto sin precio válido: ${catalogText(product.name) || item.productId}`, lineIndex); }
    if (unitPriceMinor < minimumCatalogPrice(product) * 100) {
      throw new PricingError("CATALOG_PRICE_INVALID", `Precio pendiente de revisión: ${catalogText(product.name) || item.productId}`, lineIndex);
    }
    if (previewDelivery && availableQuantity(product, variant) < item.quantity) {
      throw new PricingError("CATALOG_UNAVAILABLE", `Sin existencias suficientes: ${catalogText(product.name) || item.productId}`, lineIndex);
    }
    const lineTotalMinor = safeInteger(unitPriceMinor * item.quantity, "Total de línea");
    subtotalMinor = safeInteger(subtotalMinor + lineTotalMinor, "Subtotal");
    const productName = catalogText(product.name);
    const variantName = catalogText(variant.name);
    const firstProductImage = Array.isArray(product.images) ? product.images.find((value) => typeof value === "string") : "";
    const imageUrl = catalogText(variant.imageUrl || firstProductImage || product.imageUrl, 2048);
    lines.push({
      productId: item.productId, variantId: item.variantId, quantity: item.quantity,
      ...(decant && { productKind: "decant" }),
      name: productName, productName, variantName, imageUrl, supplyType,
      unitPrice: minorToCRC(unitPriceMinor), lineTotal: minorToCRC(lineTotalMinor),
      unitPriceMinor, lineTotalMinor,
      ...(previewDelivery && { maxQuantity: availableQuantity(product, variant) }),
    });
  }

  const delivery = decantDelivery(onlyDecants, minorToCRC(subtotalMinor));
  if (!previewDelivery && delivery.belowMinimum) throw new PricingError("DECANT_MINIMUM", MINIMUM_MESSAGE);
  const shippingCostMinor = parseMinorCRC(delivery.shippingCost, { allowZero: true });
  const totalMinor = safeInteger(subtotalMinor + shippingCostMinor, "Total");
  return {
    ...(previewDelivery && { delivery }),
    lines, subtotal: minorToCRC(subtotalMinor), shippingCost: minorToCRC(shippingCostMinor), total: minorToCRC(totalMinor),
    subtotalMinor, shippingCostMinor, totalMinor,
  };
}

module.exports = { computeTotalsCRC, GAM_CANTONES, EXPRESS_CANTONES, PricingError };
