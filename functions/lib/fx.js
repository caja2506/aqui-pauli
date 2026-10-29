// ==============================================
// Tipo de cambio CRC → USD (reutilizable por cualquier pasarela)
//
// Fuente: API pública del Ministerio de Hacienda
//   https://api.hacienda.go.cr/indicadores/tc/dolar
// que publica el tipo de cambio de referencia del BCCR (compra / venta).
//
// Se usa el valor de COMPRA (el menor): es el que recibe el comercio al
// vender los USD, así el pedido en colones queda cubierto.
//
// Prioridad:
//   1. config/payments.fx.fixedRate (override manual del admin, CRC por USD)
//   2. caché config/exchangeRate (< maxAgeHours, por defecto 6 h)
//   3. API de Hacienda (y se guarda en config/exchangeRate)
//   4. caché vieja (< staleMaxHours, por defecto 72 h) si la API falla
//   5. error
//
// config/payments.fx.bufferPct (por defecto 0): % extra que se suma al USD
// cobrado para cubrir comisión/spread de conversión.
// ==============================================

const HACIENDA_URL = "https://api.hacienda.go.cr/indicadores/tc/dolar";

/** Redondea a 2 decimales (centavos) sin errores de coma flotante comunes. */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Convierte colones a dólares. Devuelve número con 2 decimales (mínimo 0.01). */
function crcToUsd(crc, rate, bufferPct = 0) {
  if (!(rate > 0)) throw new Error("Tipo de cambio inválido");
  const usd = (crc / rate) * (1 + (bufferPct || 0) / 100);
  return Math.max(0.01, round2(usd));
}

async function fetchHaciendaRate(fetchFn = fetch) {
  const res = await fetchFn(HACIENDA_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Hacienda TC HTTP ${res.status}`);
  const j = await res.json();
  const compra = Number(j?.compra?.valor);
  const venta = Number(j?.venta?.valor);
  if (!(compra > 100 && compra < 2000)) throw new Error("Respuesta de tipo de cambio inválida");
  return { compra, venta: venta || compra, fecha: j.compra.fecha || null };
}

/**
 * @returns {{rate:number, source:string, date:string|null, bufferPct:number}}
 */
async function getFxRate(db, { fetchFn = fetch, now = Date.now() } = {}) {
  let cfg = {};
  try {
    const s = await db.collection("config").doc("payments").get();
    cfg = (s.exists && s.data().fx) || {};
  } catch (e) {
    console.warn("[fx] no se pudo leer config/payments:", e.message);
  }
  const bufferPct = Number(cfg.bufferPct) || 0;

  if (Number(cfg.fixedRate) > 0) {
    return { rate: Number(cfg.fixedRate), source: "fijo (config/payments)", date: null, bufferPct };
  }

  const maxAgeMs = (Number(cfg.maxAgeHours) || 6) * 3600 * 1000;
  const staleMaxMs = (Number(cfg.staleMaxHours) || 72) * 3600 * 1000;
  const ref = db.collection("config").doc("exchangeRate");
  let cached = null;
  try {
    const s = await ref.get();
    if (s.exists) cached = s.data();
  } catch (e) {
    console.warn("[fx] no se pudo leer config/exchangeRate:", e.message);
  }
  const cachedAge = cached?.fetchedAtMs ? now - cached.fetchedAtMs : Infinity;
  if (cached?.compra > 0 && cachedAge < maxAgeMs) {
    return { rate: cached.compra, source: "BCCR vía Hacienda (caché)", date: cached.fecha || null, bufferPct };
  }

  try {
    const fresh = await fetchHaciendaRate(fetchFn);
    await ref.set({ ...fresh, source: "hacienda", fetchedAtMs: now, fetchedAt: new Date(now).toISOString() });
    return { rate: fresh.compra, source: "BCCR vía Hacienda", date: fresh.fecha, bufferPct };
  } catch (e) {
    console.error("[fx] fallo al consultar Hacienda:", e.message);
    if (cached?.compra > 0 && cachedAge < staleMaxMs) {
      return { rate: cached.compra, source: "BCCR vía Hacienda (caché vieja)", date: cached.fecha || null, bufferPct };
    }
    throw new Error("No hay tipo de cambio disponible");
  }
}

module.exports = { round2, crcToUsd, fetchHaciendaRate, getFxRate };
