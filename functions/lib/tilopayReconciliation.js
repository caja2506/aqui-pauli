"use strict";

const { randomUUID } = require("node:crypto");
const { applyPaidOrder } = require("./orderFulfillment");

const COLLECTION = "tilopayReconciliation";
const MINUTE = 60 * 1000;
const PENDING_DELAY = 5 * MINUTE;
const PAID_DELAY = 24 * 60 * MINUTE;
const MAX_ERROR_DELAY = 6 * 60 * MINUTE;
const LEASE_DURATION = 10 * MINUTE;
const RUN_BUDGET = 7 * MINUTE;
const PAGE_SIZE = 25;
const CONCURRENCY = 4;
const PAID_RESULTS = new Set(["paid", "already_paid"]);
const VALID_RESULTS = new Set(["paid", "already_paid", "pending", "review", "declined", "skipped", "test_paid"]);
const iso = (time) => new Date(time).toISOString();
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000000) : 0;
const safeCode = (value) => typeof value === "string" && /^[a-z_-]{1,64}$/.test(value) ? value : "";

function reviewResult(result) {
  return { ...result, result: "review", code: "fulfillment_review", retry: false,
    message: "El pago está acreditado, pero el pedido necesita revisión antes de prepararlo. Conservá este número de pedido y no vuelvas a pagar." };
}

/** La evidencia ya acreditada se procesa sin depender de avisos SMTP o Telegram. */
async function completeTilopayPayment({ db, result, crmDefaults = {} }) {
  if (!PAID_RESULTS.has(result?.result)) return result;
  const orderId = result.orderId;
  if (typeof orderId !== "string" || !orderId || orderId.includes("/")) throw new Error("Resultado Tilopay sin pedido válido");
  const fulfillment = await applyPaidOrder({ db, orderId, crmDefaults });
  if (fulfillment.kind === "review" || fulfillment.kind === "missing") return reviewResult(result);
  if (fulfillment.kind === "noop") {
    // Una cancelación/revisión concurrente nunca se presenta como lista para preparar.
    const latest = await db.collection("orders").doc(orderId).get();
    const order = latest.exists ? latest.data() : null;
    if (!order || order.fulfillment?.state !== "applied"
        || ["cancelado", "reembolsado", "devuelto", "revision_manual"].includes(order.status)) return reviewResult(result);
  }
  return result;
}

function nextSchedule(entry, result, failed, now) {
  const transient = failed || result?.code === "pending_reconciliation";
  const errors = transient ? count(entry.consecutiveErrors) + 1 : 0;
  let delay;
  if (transient) delay = Math.min(MAX_ERROR_DELAY, PENDING_DELAY * 2 ** Math.min(errors - 1, 10));
  else if (PAID_RESULTS.has(result?.result) || result?.result === "declined"
      || (result?.result === "review" && result?.code !== "pending_capture")) delay = PAID_DELAY;
  else delay = PENDING_DELAY;
  return { nextCheckAt: iso(now + delay), consecutiveErrors: errors };
}

/**
 * Cola exclusivamente servidor. LIVE se encola en la misma transacción que su
 * intento. Cada claim mueve nextCheckAt hasta vencer el lease, por lo que un
 * proceso caído no bloquea la cola ni requiere borrar evidencias de pago.
 * Sólo recibe reconcile (consult); nunca createPayment ni una API de captura.
 */
function createTilopayReconciler({ db, reconcile, crmDefaults = {}, clock = () => Date.now(), randomId = randomUUID }) {
  async function claim(ref) {
    const leaseId = randomId();
    return db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists) return null;
      const entry = snap.data();
      const time = clock();
      if (typeof entry.nextCheckAt !== "string" || !Number.isFinite(Date.parse(entry.nextCheckAt))
          || Date.parse(entry.nextCheckAt) > time
          || (typeof entry.leaseUntil === "string" && Date.parse(entry.leaseUntil) > time)) return null;
      const leaseUntil = iso(time + LEASE_DURATION);
      transaction.update(ref, { leaseId, leaseUntil, nextCheckAt: leaseUntil,
        lastStartedAt: iso(time), updatedAt: iso(time) });
      return { ...entry, leaseId };
    });
  }

  async function finish(ref, entry, result, failed) {
    return db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists || snap.data().leaseId !== entry.leaseId) return false;
      if (!failed && result?.result === "skipped" && result.reason === "not_live") {
        // No existen cobros LIVE que supervisar: no se consultan credenciales test.
        transaction.delete(ref);
        return true;
      }
      const time = clock();
      transaction.update(ref, {
        ...nextSchedule(entry, result, failed, time),
        leaseId: "", leaseUntil: "", lastCheckedAt: iso(time), updatedAt: iso(time),
        checkCount: count(entry.checkCount) + 1,
        lastResult: failed ? "error" : result.result,
        // Sólo un código estable, nunca respuestas del proveedor, tokens ni datos personales.
        lastCode: failed ? "consult_failed" : safeCode(result.code),
      });
      return true;
    });
  }

  async function run() {
    const start = clock();
    const deadline = start + RUN_BUDGET;
    const page = await db.collection(COLLECTION).where("nextCheckAt", "<=", iso(start))
      .orderBy("nextCheckAt").limit(PAGE_SIZE).get();
    const stats = { scanned: page.size, claimed: 0, checked: 0, failed: 0, queueErrors: 0, released: 0, leaseLost: 0, deferred: 0 };
    let index = 0;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, page.docs.length) }, async () => {
      while (index < page.docs.length && clock() + 25000 < deadline) {
        const doc = page.docs[index++];
        const entry = await claim(doc.ref);
        if (!entry) continue;
        stats.claimed++;
        let result; let failed = false;
        try {
          // La identidad está en el docId; un dato inconsistente no consulta otra orden.
          if (entry.orderId !== doc.id) throw new Error("Identidad de cola inconsistente");
          result = await reconcile(doc.id, { deadline });
          if (!VALID_RESULTS.has(result?.result) || result.orderId !== doc.id) throw new Error("Respuesta de conciliación inválida");
          stats.checked++;
          result = await completeTilopayPayment({ db, result, crmDefaults });
        } catch {
          failed = true;
          stats.failed++;
        }
        // Un fallo de inventario/CRM también se reintenta; no repite el cobro.
        if (await finish(doc.ref, entry, result, failed)) stats.released++;
        else stats.leaseLost++;
      }
    }));
    stats.queueErrors = workers.filter((worker) => worker.status === "rejected").length;
    stats.deferred = page.docs.length - index;
    return stats;
  }

  return { run };
}

module.exports = { completeTilopayPayment, createTilopayReconciler };
