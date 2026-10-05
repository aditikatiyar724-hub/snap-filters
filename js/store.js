/* Snap storage in IndexedDB (falls back to in-memory if unavailable). */

const SnapStore = (() => {
  const DB = 'snap-filters';
  const STORE = 'snaps';
  let dbPromise = null;
  const memory = [];

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result && result.result);
      t.onerror = () => reject(t.error);
    });
  }

  async function add(snap) {
    const db = await open();
    if (!db) { memory.push(snap); return; }
    try { await tx(db, 'readwrite', (s) => s.put(snap)); } catch { memory.push(snap); }
  }

  async function all() {
    const db = await open();
    let rows = [];
    if (db) {
      try { rows = await tx(db, 'readonly', (s) => s.getAll()); } catch { rows = []; }
    }
    return [...rows, ...memory].sort((a, b) => b.created - a.created);
  }

  async function remove(id) {
    const i = memory.findIndex((s) => s.id === id);
    if (i >= 0) memory.splice(i, 1);
    const db = await open();
    if (db) {
      try { await tx(db, 'readwrite', (s) => s.delete(id)); } catch { /* ignore */ }
    }
  }

  return { add, all, remove };
})();
