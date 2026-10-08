// Minimal IndexedDB wrapper. Everything stays on this device.
// Tests run against a separate database ("?db=test-…" or a global set by tests.html) so they never touch real data.
const qp = new URLSearchParams(location.search).get('db');
export const TEST_DB = (qp && /^test-[\w-]+$/.test(qp) ? qp : null) || globalThis.__HAMESADER_DB__ || null;
const DB_NAME = TEST_DB || 'hamesader';
const DB_VERSION = 2; // v2 adds 'inbox' (quick capture while locked)
export const STORES = ['meta', 'entries', 'photos', 'blobs', 'audio', 'summaries', 'inbox'];

let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return openDb().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

export const get = (store, id) => run(store, 'readonly', (s) => s.get(id));
export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const put = (store, value) => run(store, 'readwrite', (s) => { s.put(value); return null; });
export const del = (store, id) => run(store, 'readwrite', (s) => { s.delete(id); return null; });
export const clear = (store) => run(store, 'readwrite', (s) => { s.clear(); return null; });

export async function clearAll() {
  for (const s of STORES) await clear(s);
}

// For tests: drop the whole database.
export function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const go = () => {
      const r = indexedDB.deleteDatabase(DB_NAME);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
      r.onblocked = () => resolve();
    };
    if (dbPromise) dbPromise.then((d) => { d.close(); dbPromise = null; go(); }); else go();
  });
}
