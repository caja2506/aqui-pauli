"use strict";

// A deterministic optimistic transaction double. Writes commit together; aborted
// transactions never leak writes. Query versions detect inserted/deleted items.
// This exercises application interleavings; it does not replace the Emulator.
function createMemoryFirestore(seed = {}) {
  const store = structuredClone(seed);
  const versions = new Map(Object.keys(store).map((path) => [path, 1]));
  const collections = new Map();
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const collectionPath = (path) => path.slice(0, path.lastIndexOf("/"));
  const stats = { commits: 0, retries: 0 };
  let counter = 0;

  function applyField(current, value) {
    if (value && typeof value === "object" && value.__increment !== undefined) return (current || 0) + value.__increment;
    if (value && typeof value === "object" && value.__deleteField) return undefined;
    return clone(value);
  }
  function mergeFields(current, patch) {
    const out = clone(current || {});
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split(".");
      let target = out;
      for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {});
      const name = parts.at(-1);
      const resolved = applyField(target[name], value);
      if (resolved === undefined) delete target[name]; else target[name] = resolved;
    }
    return out;
  }
  function write(kind, path, value, options) {
    if (kind === "update" && store[path] === undefined) throw new Error(`Missing document: ${path}`);
    if (kind === "create" && store[path] !== undefined) throw new Error(`Document exists: ${path}`);
    if (kind === "delete") delete store[path];
    else store[path] = kind === "update" || options?.merge ? mergeFields(store[path], value) : clone(value);
    versions.set(path, (versions.get(path) || 0) + 1);
    const collection = collectionPath(path);
    collections.set(collection, (collections.get(collection) || 0) + 1);
  }
  function docSnapshot(path, data) {
    return { id: path.slice(path.lastIndexOf("/") + 1), ref: docRef(path), exists: data !== undefined,
      data: () => clone(data), get: (key) => clone(data?.[key]) };
  }
  function querySnapshot(query, data) {
    const prefix = query.path + "/";
    const paths = Object.keys(data).filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .filter((path) => (query.filters || []).every(([field, operator, value]) => {
        const actual = data[path]?.[field];
        if (operator === "==") return actual === value;
        if (operator === "<") return actual !== undefined && actual < value;
        throw new Error(`Unsupported test query operator: ${operator}`);
      }))
      .sort().slice(0, query.max);
    const docs = paths.map((path) => docSnapshot(path, data[path]));
    return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
  }
  function docRef(path) {
    return { path, id: path.slice(path.lastIndexOf("/") + 1), kind: "doc",
      collection: (name) => queryRef(`${path}/${name}`),
      get: async () => docSnapshot(path, store[path]),
      set: async (value, options) => write("set", path, value, options),
      update: async (value) => write("update", path, value),
      delete: async () => write("delete", path),
      create: async (value) => write("create", path, value),
    };
  }
  function queryRef(path, max = Infinity, filters = []) {
    return { path, max, filters, kind: "query", doc: (id = `server${++counter}`) => docRef(`${path}/${id}`),
      limit: (count) => queryRef(path, count, filters),
      where: (field, operator, value) => queryRef(path, max, [...filters, [field, operator, value]]),
      get: async () => querySnapshot({ path, max, filters }, store) };
  }
  const db = {
    collection: (path) => queryRef(path), doc: (path) => docRef(path),
    beforeCommit: null,
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const snapshot = clone(store);
        const startVersions = new Map(versions);
        const startCollections = new Map(collections);
        const reads = new Map(); const queryReads = new Map(); const writes = [];
        const tx = {
          get: async (ref) => {
            if (writes.length) throw new Error("Reads after writes in transaction");
            if (ref.kind === "query") {
              queryReads.set(ref.path, startCollections.get(ref.path) || 0);
              return querySnapshot(ref, snapshot);
            }
            reads.set(ref.path, startVersions.get(ref.path) || 0);
            return docSnapshot(ref.path, snapshot[ref.path]);
          },
          set: (ref, value, options) => { writes.push(["set", ref.path, clone(value), options]); return tx; },
          update: (ref, value) => { writes.push(["update", ref.path, clone(value)]); return tx; },
          create: (ref, value) => { writes.push(["create", ref.path, clone(value)]); return tx; },
          delete: (ref) => { writes.push(["delete", ref.path]); return tx; },
        };
        const result = await fn(tx);
        if (db.beforeCommit) await db.beforeCommit({ attempt, reads, queryReads, writes, db });
        const conflict = [...reads].some(([path, version]) => (versions.get(path) || 0) !== version)
          || [...queryReads].some(([path, version]) => (collections.get(path) || 0) !== version);
        if (conflict) { stats.retries++; continue; }
        // Validate the whole batch before making its effects visible.
        for (const [kind, path] of writes) {
          if (kind === "update" && store[path] === undefined) throw new Error(`Missing document: ${path}`);
          if (kind === "create" && store[path] !== undefined) throw new Error(`Document exists: ${path}`);
        }
        for (const args of writes) write(...args);
        stats.commits++;
        return result;
      }
      throw new Error("Too much transaction contention in test");
    },
    batch() {
      const writes = [];
      const batch = {
        set: (ref, value, options) => { writes.push(["set", ref.path, value, options]); return batch; },
        update: (ref, value) => { writes.push(["update", ref.path, value]); return batch; },
        delete: (ref) => { writes.push(["delete", ref.path]); return batch; },
        commit: async () => { for (const args of writes) write(...args); },
      };
      return batch;
    },
  };
  return { db, store, stats, get: (path) => clone(store[path]),
    set: async (path, value) => write("set", path, value),
    FieldValue: { increment: (value) => ({ __increment: value }), delete: () => ({ __deleteField: true }) } };
}

module.exports = { createMemoryFirestore };
