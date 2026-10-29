"use strict";

// Older fulfillment code could decrement reservedStock without a reservation.
// Normalize that derived counter without inventing or changing physical stock.
const WARNING_CONTEXTS = new Set([
  "inventory", "pricing", "tilopay_reserve", "fulfillment", "reservation", "migration",
]);

function defaultWarning(event) {
  console.warn(JSON.stringify(event));
}

/**
 * Return numeric stock and a conservative reservedStock in [0, stock].
 * Missing stock retains the existing zero default; present physical stock must
 * be a nonnegative safe integer. Missing/malformed reservations become zero,
 * positive fractions round UP, and reservations above stock clamp to stock.
 * This pure helper never changes the source object or writes to Firestore.
 * Callers must use these values inside their stock transaction when reserving,
 * consuming or releasing inventory. A quote only validates; it does not repair.
 */
function normalizeInventoryStock(data, { context = "inventory", onWarning = defaultWarning } = {}) {
  const stock = data?.stock ?? 0;
  if (typeof stock !== "number" || !Number.isSafeInteger(stock) || stock < 0) {
    const error = new Error("Stock físico inválido; requiere revisión");
    error.code = "INVENTORY_STOCK_INVALID";
    throw error;
  }

  const raw = data?.reservedStock;
  const reasons = [];
  let reservedStock;
  if (raw === undefined || raw === null) {
    reservedStock = 0;
    reasons.push("missing");
  } else if (typeof raw !== "number") {
    reservedStock = 0;
    reasons.push("non_numeric");
  } else if (!Number.isFinite(raw)) {
    reservedStock = 0;
    reasons.push("non_finite");
  } else if (raw < 0) {
    reservedStock = 0;
    reasons.push("negative");
  } else {
    reservedStock = Math.ceil(raw);
    if (!Number.isInteger(raw)) reasons.push("fractional");
    if (reservedStock > stock) {
      reservedStock = stock;
      reasons.push("above_stock");
    }
    if (Object.is(reservedStock, -0)) reservedStock = 0;
  }

  if (reasons.length) {
    const warning = {
      severity: "WARNING", event: "inventory_reserved_stock_normalized",
      context: WARNING_CONTEXTS.has(context) ? context : "inventory",
      reasons, stock, reservedStock,
    };
    // Never echo arbitrary catalog fields, IDs, order/customer data or raw values.
    // Telemetry failure must not turn tolerated legacy data into checkout failure.
    try { (typeof onWarning === "function" ? onWarning : defaultWarning)(warning); } catch { /* best effort */ }
  }
  return { stock, reservedStock };
}

module.exports = { normalizeInventoryStock };
