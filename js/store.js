/* Stockage local (IndexedDB) : tout reste sur le téléphone. */
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('golftrack', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore('kv');
          d.createObjectStore('courses', { keyPath: 'id' });
          d.createObjectStore('rounds', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  function tx(store, mode, fn) {
    return open().then(d => new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }
  return {
    get: (st, k) => tx(st, 'readonly', s => s.get(k)),
    all: st => tx(st, 'readonly', s => s.getAll()),
    put: (st, v, k) => tx(st, 'readwrite', s => (k === undefined ? s.put(v) : s.put(v, k))),
    del: (st, k) => tx(st, 'readwrite', s => s.delete(k)),
    clear: st => tx(st, 'readwrite', s => s.clear()),
  };
})();

// Demande au navigateur de ne jamais effacer les données automatiquement.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
