"use strict";

/**
 * Money is compared and stored as integer minor units (1 CRC = 100 minor units).
 * Strings must be ordinary decimal notation, never exponent/comma notation.
 * No rounding: an amount with more than two decimal places is invalid.
 */
function parseMinorCRC(value, { allowZero = false } = {}) {
  if ((typeof value !== "string" && typeof value !== "number")
      || (typeof value === "number" && !Number.isFinite(value))) {
    throw new TypeError("Monto CRC inválido.");
  }
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new TypeError("El monto CRC debe tener como máximo dos decimales, sin redondeo.");
  }
  const [whole, fraction = ""] = text.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || (!allowZero && minor === 0n)) {
    throw new RangeError("Monto CRC fuera del rango permitido.");
  }
  return Number(minor);
}

function validateMinor(minor) {
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 0) {
    throw new TypeError("El monto en unidades menores debe ser un entero seguro no negativo.");
  }
  return BigInt(minor);
}

function formatMinorCRC(minor) {
  const value = validateMinor(minor);
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

/** Presentation/legacy numeric field only; all comparisons must keep minor units. */
function minorToCRC(minor) {
  const amount = Number(formatMinorCRC(minor));
  if (parseMinorCRC(amount, { allowZero: true }) !== minor) {
    throw new RangeError("El monto CRC no se puede representar como número sin perder centavos.");
  }
  return amount;
}

module.exports = { parseMinorCRC, minorToCRC, formatMinorCRC };
