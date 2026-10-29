"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryFirestore } = require("./helpers/memoryFirestore");
const { parseArgs, isProductVariantPath, migrateReservedStock, main } = require("../scripts/fix-reserved-stock");
const PROJECT = "demo-aqui-pauli-audit";
const VARIANT = "products/p1/variants/v1";

// Add only the paginated collection-group query used by this migration to the
// existing optimistic transaction double. No Firebase SDK or network is loaded.
function harness(seed = {}) {
  const h = createMemoryFirestore(seed);
  const queries = [];
  let afterPage = null;
  function query(group, options = {}) {
    return {
      orderBy: (field) => query(group, { ...options, field }),
      limit: (limit) => query(group, { ...options, limit }),
      startAfter: (cursor) => query(group, { ...options, after: cursor.ref.path }),
      get: async () => {
        assert.equal(options.field, "__name__");
        assert.ok(Number.isInteger(options.limit));
        queries.push({ ...options, group });
        const paths = Object.keys(h.store).filter((path) => path.split("/").at(-2) === group)
          .filter((path) => !options.after || path > options.after).sort().slice(0, options.limit);
        const docs = await Promise.all(paths.map((path) => h.db.doc(path).get()));
        if (afterPage) await afterPage();
        return { docs, empty: !docs.length, size: docs.length };
      },
    };
  }
  h.db.collectionGroup = (name) => query(name);
  return { ...h, queries, setAfterPage: (fn) => { afterPage = fn; } };
}

const run = (h, extra = {}) => migrateReservedStock({ db: h.db, projectId: PROJECT, onEvent() {}, ...extra });

test("CLI requiere proyecto explícito y dry-run es el default; --apply es opt-in inequívoco", () => {
  assert.deepEqual(parseArgs(["--project", PROJECT]), { projectId: PROJECT, apply: false, pageSize: 200, help: false });
  assert.equal(parseArgs([`--project=${PROJECT}`, "--dry-run"]).apply, false);
  assert.equal(parseArgs(["--project", PROJECT, "--apply", "--page-size", "2"]).apply, true);
  for (const args of [[], ["--apply"], ["--project", PROJECT, "--apply", "--dry-run"],
    ["--project", PROJECT, "--dry-run", "--apply"], ["--project", PROJECT, "--apply", "--apply"],
    ["--project", "aqui/pauli"], ["--project", PROJECT, "--page-size=0"],
    ["--project", PROJECT, "--page-size", "501"], ["--project", PROJECT, "--page-size=1.5"],
    ["--project", PROJECT, "--project", "aqui-pauli"], ["--project", PROJECT, "--unknown"]]) {
    assert.throws(() => parseArgs(args));
  }
});

test("dry-run pagina candidatos y reporta sin escribir ningún campo", async () => {
  const h = harness({
    [VARIANT]: { stock: 10, reservedStock: -1, name: "catalog-name", price: 10 },
    "products/p2/variants/v2": { stock: 3, reservedStock: 5 },
    "products/p3/variants/v3": { stock: 7, reservedStock: 2 },
  });
  const before = structuredClone(h.store);
  const events = [];
  const result = await run(h, { pageSize: 2, onEvent: (event) => events.push(event) });
  assert.deepEqual(h.store, before);
  assert.equal(result.dryRun, true);
  assert.equal(result.pages, 2);
  assert.equal(result.changes, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.unchanged, 1);
  assert.ok(h.queries[1].after);
  assert.equal(events.filter((event) => event.event === "inventory_reserved_stock_would_repair").length, 2);
  assert.ok(!JSON.stringify(events).includes("catalog-name"));
  assert.ok(!JSON.stringify(events).includes(VARIANT));
});

test("apply sólo repara reservedStock de rutas exactas de productos y es idempotente", async () => {
  const unrelated = {
    "shops/shop1/variants/private": { stock: 10, reservedStock: -10 },
    "products/p1/groups/g1/variants/deep": { stock: 10, reservedStock: -10 },
    "variants/root": { stock: 10, reservedStock: -10 },
  };
  const h = harness({
    [VARIANT]: { stock: 10, reservedStock: -1, price: 123, updatedAt: "unchanged" },
    "products/p2/variants/v2": { stock: 3, reservedStock: 99, active: true },
    "products/orphan/variants/v": { stock: 8 },
    ...unrelated,
  });
  const first = await run(h, { apply: true, pageSize: 2 });
  assert.equal(first.updated, 3);
  assert.equal(first.skippedPaths, 3);
  assert.deepEqual(h.get(VARIANT), { stock: 10, reservedStock: 0, price: 123, updatedAt: "unchanged" });
  assert.deepEqual(h.get("products/p2/variants/v2"), { stock: 3, reservedStock: 3, active: true });
  assert.deepEqual(h.get("products/orphan/variants/v"), { stock: 8, reservedStock: 0 });
  for (const [path, data] of Object.entries(unrelated)) assert.deepEqual(h.get(path), data);
  const second = await run(h, { apply: true, pageSize: 2 });
  assert.equal(second.updated, 0);
  assert.equal(second.changes, 0);
  assert.equal(second.unchanged, 3);
  assert.equal(isProductVariantPath(VARIANT), true);
  for (const path of Object.keys(unrelated)) assert.equal(isProductVariantPath(path), false);
});

test("stock físico corrupto se reporta sin modificarlo y no impide reparar otras variantes", async () => {
  const h = harness({ [VARIANT]: { stock: -1, reservedStock: -1 },
    "products/p2/variants/v2": { stock: 5, reservedStock: -1 } });
  const events = [];
  const result = await run(h, { apply: true, onEvent: (event) => events.push(event) });
  assert.equal(result.invalidStock, 1);
  assert.equal(result.updated, 1);
  assert.deepEqual(h.get(VARIANT), { stock: -1, reservedStock: -1 });
  assert.ok(events.some((event) => event.code === "INVENTORY_STOCK_INVALID"));
});

test("transacción vuelve a leer, sin usar el dato viejo de la página", async () => {
  const h = harness({ [VARIANT]: { stock: 10, reservedStock: -1 } });
  h.setAfterPage(async () => {
    h.setAfterPage(null);
    await h.db.doc(VARIANT).update({ reservedStock: 4, concurrentReservation: true });
  });
  const result = await run(h, { apply: true });
  assert.equal(result.updated, 0);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(h.get(VARIANT), { stock: 10, reservedStock: 4, concurrentReservation: true });
});

test("una reserva concurrente entre lectura y commit fuerza reintento y no es borrada", async () => {
  const h = harness({ [VARIANT]: { stock: 10, reservedStock: -1 } });
  h.db.beforeCommit = async ({ reads }) => {
    if (!reads.has(VARIANT)) return;
    h.db.beforeCommit = null;
    await h.db.doc(VARIANT).update({ reservedStock: 3 });
  };
  const events = [];
  const result = await run(h, { apply: true, onEvent: (event) => events.push(event) });
  assert.equal(h.stats.retries, 1);
  assert.equal(h.get(VARIANT).reservedStock, 3);
  assert.equal(result.updated, 0);
  assert.equal(result.unchanged, 1);
  assert.ok(!events.some((event) => event.event === "inventory_reserved_stock_repaired"));
});

test("variante eliminada después del scan se salta sin recrearla", async () => {
  const h = harness({ [VARIANT]: { stock: 10, reservedStock: -1 } });
  h.setAfterPage(async () => { h.setAfterPage(null); await h.db.doc(VARIANT).delete(); });
  const result = await run(h, { apply: true });
  assert.equal(result.missing, 1);
  assert.equal(result.updated, 0);
  assert.equal(h.get(VARIANT), undefined);
});

test("help y errores de destino no inicializan credenciales ni Firestore", async () => {
  let opened = false;
  const openFirestore = async () => { opened = true; throw new Error("unexpected network"); };
  assert.equal(await main(["--help"], { openFirestore, printHelp() {} }), 0);
  await assert.rejects(main([], { openFirestore }));
  await assert.rejects(main(["--project", PROJECT], {
    openFirestore, env: { FIRESTORE_EMULATOR_HOST: "remote.example:8080" },
  }));
  assert.equal(opened, false);
});

test("main identifica destino, mantiene dry-run y devuelve 2 si queda stock físico inválido", async () => {
  const h = harness({ [VARIANT]: { stock: -1, reservedStock: -1 } });
  const events = [];
  let closed = false;
  const code = await main(["--project", PROJECT], {
    env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:18080" }, onEvent: (event) => events.push(event),
    openFirestore: async (project) => {
      assert.equal(project, PROJECT);
      return { db: h.db, close: async () => { closed = true; } };
    },
  });
  assert.equal(code, 2);
  assert.equal(closed, true);
  assert.deepEqual(events[0], { severity: "INFO", event: "inventory_reserved_stock_migration_start",
    projectId: PROJECT, database: "(default)", target: "local_emulator", emulatorHost: "127.0.0.1:18080",
    dryRun: true, pageSize: 200 });
  assert.deepEqual(h.get(VARIANT), { stock: -1, reservedStock: -1 });
});
