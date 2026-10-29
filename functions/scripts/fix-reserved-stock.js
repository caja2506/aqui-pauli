#!/usr/bin/env node
"use strict";

// Run from functions/ after installing its dependencies, using existing ADC.
// Preview (the default): node scripts/fix-reserved-stock.js --project aqui-pauli
// Apply deliberately:   node scripts/fix-reserved-stock.js --project aqui-pauli --apply
// Only reservedStock at products/{product}/variants/{variant} can be updated.
// Each candidate is reread in a transaction: a concurrent reservation is never
// overwritten with a value computed from a stale query snapshot. Re-running is
// safe; a paginated scan is not a global snapshot and may be run again if catalog
// documents were created behind its cursor. Physical stock is never repaired.
const { createHash } = require("node:crypto");
const { normalizeInventoryStock } = require("../lib/inventoryStock");

const HELP = `Repair legacy reservedStock counters (default: dry-run).

Usage:
  node scripts/fix-reserved-stock.js --project PROJECT_ID [--dry-run | --apply] [--page-size 200]

An explicit project is required. The target is that project's default Firestore
database, using configured Application Default Credentials. --apply is the only
option that writes. --dry-run and --apply cannot be combined. A local
FIRESTORE_EMULATOR_HOST, if set, is printed as the target instead of production.

Only products/{product}/variants/{variant}.reservedStock is updated. Invalid
physical stock is reported and skipped (exit code 2); it is never invented.
Logs contain counts, normalized quantities and a document-path SHA-256, without
catalog/customer fields, raw malformed values, credentials or order data.
`;

class UsageError extends Error {}

function validProjectId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

function parseArgs(args) {
  const options = { apply: false, pageSize: 200, projectId: null, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--apply" || arg === "--dry-run") {
      if (seen.has("mode")) throw new UsageError("Indicá una sola opción: --dry-run o --apply.");
      seen.add("mode"); options.apply = arg === "--apply"; continue;
    }
    const match = /^(--project|--page-size)(?:=(.*))?$/.exec(arg);
    if (!match) throw new UsageError("Opción desconocida. Usá --help para ver las opciones permitidas.");
    const flag = match[1];
    if (seen.has(flag)) throw new UsageError("Una opción de destino o paginación está repetida.");
    seen.add(flag);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith("--")) throw new UsageError("Falta un valor para --project o --page-size.");
    if (flag === "--project") options.projectId = value;
    else {
      if (!/^\d+$/.test(value)) throw new UsageError("--page-size debe ser un entero entre 1 y 500.");
      options.pageSize = Number(value);
    }
  }
  if (options.help) return options;
  if (!validProjectId(options.projectId)) throw new UsageError("Se requiere --project con un ID de proyecto válido y explícito.");
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 500) {
    throw new UsageError("--page-size debe ser un entero entre 1 y 500.");
  }
  return options;
}

function isProductVariantPath(path) {
  if (typeof path !== "string") return false;
  const parts = path.split("/");
  return parts.length === 4 && parts[0] === "products" && !!parts[1]
    && parts[2] === "variants" && !!parts[3];
}

function pathHash(path) {
  return createHash("sha256").update(path).digest("hex");
}

const logJson = (event) => console.log(JSON.stringify(event));

/** Injectable for local tests: no credentials or Firebase module are loaded here. */
async function migrateReservedStock({ db, projectId, apply = false, pageSize = 200,
  documentIdField = "__name__", onEvent = logJson }) {
  if (!validProjectId(projectId)) throw new UsageError("La migración requiere projectId explícito.");
  if (typeof apply !== "boolean") throw new UsageError("apply debe ser booleano explícito.");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new UsageError("pageSize inválido.");
  if (!db || typeof db.collectionGroup !== "function" || typeof db.runTransaction !== "function") {
    throw new UsageError("Firestore no fue configurado.");
  }

  const summary = { projectId, dryRun: !apply, pages: 0, scanned: 0, variants: 0,
    skippedPaths: 0, missing: 0, invalidStock: 0, unchanged: 0, changes: 0, updated: 0 };
  // Collection group scanning also sees orphan variants if a product document was
  // removed. The exact path guard excludes every unrelated or nested collection.
  const firstPage = db.collectionGroup("variants").orderBy(documentIdField).limit(pageSize);
  let cursor;
  while (true) {
    const page = await (cursor ? firstPage.startAfter(cursor) : firstPage).get();
    if (page.empty || page.docs.length === 0) break;
    summary.pages++;
    for (const candidate of page.docs) {
      summary.scanned++;
      if (!isProductVariantPath(candidate.ref.path)) { summary.skippedPaths++; continue; }
      summary.variants++;
      const result = await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(candidate.ref);
        if (!fresh.exists) return { kind: "missing" };
        const data = fresh.data();
        let warning;
        let normalized;
        try {
          normalized = normalizeInventoryStock(data, { context: "migration", onWarning: (event) => { warning = event; } });
        } catch (error) {
          if (error.code === "INVENTORY_STOCK_INVALID") return { kind: "invalidStock" };
          throw error;
        }
        if (Object.is(data.reservedStock, normalized.reservedStock)) return { kind: "unchanged" };
        if (apply) transaction.update(candidate.ref, { reservedStock: normalized.reservedStock });
        return { kind: "change", ...normalized, warning };
      });
      if (result.kind === "change") {
        summary.changes++;
        if (apply) summary.updated++;
        // Log only the successful transaction outcome; retries do not duplicate
        // dry-run plans or warnings for updates that ultimately did not commit.
        onEvent({ severity: "WARNING", event: apply ? "inventory_reserved_stock_repaired" : "inventory_reserved_stock_would_repair",
          documentPathHash: pathHash(candidate.ref.path), reasons: result.warning?.reasons || ["noncanonical_zero"],
          stock: result.stock, reservedStock: result.reservedStock });
      } else {
        summary[result.kind]++;
        if (result.kind === "invalidStock") onEvent({ severity: "WARNING", event: "inventory_physical_stock_invalid",
          documentPathHash: pathHash(candidate.ref.path), code: "INVENTORY_STOCK_INVALID" });
      }
    }
    cursor = page.docs[page.docs.length - 1];
    if (page.docs.length < pageSize) break;
  }
  onEvent({ severity: "INFO", event: "inventory_reserved_stock_migration_complete", ...summary });
  return summary;
}

function emulatorTarget(env) {
  const host = env.FIRESTORE_EMULATOR_HOST;
  if (!host) return null;
  const match = /^(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(host);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new UsageError("FIRESTORE_EMULATOR_HOST debe identificar un emulador local con puerto válido.");
  }
  return host;
}

async function createFirestore(projectId) {
  // Import only after parsing a deliberate destination; --help never needs ADC.
  const { initializeApp, applicationDefault, deleteApp } = require("firebase-admin/app");
  const { getFirestore, FieldPath } = require("firebase-admin/firestore");
  const app = initializeApp({ projectId, credential: applicationDefault() }, "fix-reserved-stock");
  return { db: getFirestore(app), documentIdField: FieldPath.documentId(), close: () => deleteApp(app) };
}

async function main(args = process.argv.slice(2), { env = process.env, openFirestore = createFirestore,
  onEvent = logJson, printHelp = (text) => console.log(text) } = {}) {
  const options = parseArgs(args);
  if (options.help) { printHelp(HELP); return 0; }
  const emulatorHost = emulatorTarget(env);
  onEvent({ severity: "INFO", event: "inventory_reserved_stock_migration_start",
    projectId: options.projectId, database: "(default)", target: emulatorHost ? "local_emulator" : "firestore",
    ...(emulatorHost ? { emulatorHost } : {}), dryRun: !options.apply, pageSize: options.pageSize });
  const connection = await openFirestore(options.projectId);
  try {
    const result = await migrateReservedStock({ ...options, db: connection.db,
      documentIdField: connection.documentIdField, onEvent });
    return result.invalidStock ? 2 : 0;
  } finally { if (connection.close) await connection.close(); }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(JSON.stringify({ severity: "ERROR", event: "inventory_reserved_stock_migration_failed",
      ...(error instanceof UsageError ? { message: error.message } : { message: "La migración falló; revisá acceso, dependencias y conectividad del proyecto indicado." }) }));
    process.exitCode = 1;
  });
}

module.exports = { HELP, parseArgs, isProductVariantPath, migrateReservedStock, main };
