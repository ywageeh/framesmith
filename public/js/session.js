// Last-session persistence in IndexedDB, so a reload never loses work.
// Everything stays on this device; failures (private mode, quota) degrade to "not remembered".

const DB = 'framesmith';
const STORE = 'kv';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Resolve to `fallback` if `p` hasn't settled in `ms` (IndexedDB can hang on some browsers). */
const within = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

export async function loadSession() {
  try {
    return (await within(tx('readonly', (s) => s.get('session')), 1200, null)) || null;
  } catch {
    return null;
  }
}

export async function saveSession(value) {
  try {
    await tx('readwrite', (s) => s.put(value, 'session'));
    return true;
  } catch {
    return false;
  }
}

export async function clearSession() {
  try {
    await tx('readwrite', (s) => s.delete('session'));
  } catch {
    /* nothing stored */
  }
}
