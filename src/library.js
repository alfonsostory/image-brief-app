// Persists uploaded images, audio and editing notes in IndexedDB so the client's library survives a page refresh.
// Records look like { id, kind: "images" | "audio", name, type, size, blob, addedAt, tag? } or { id, kind: "notes", text, addedAt }.
const DB_NAME = "image-brief-library";
const STORE = "assets";

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(req?.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      })
  );
}

export const loadAssets = () => run("readonly", (s) => s.getAll()).then((r) => r || []);
// `url` is a session-only object URL, so it is stripped before storing
export const saveAsset = ({ url, ...asset }) => run("readwrite", (s) => s.put(asset));
export const deleteAsset = (id) => run("readwrite", (s) => s.delete(id));
export const updateAsset = (id, patch) =>
  run("readwrite", (s) => {
    const get = s.get(id);
    get.onsuccess = () => { if (get.result) s.put({ ...get.result, ...patch }); };
    return get;
  });
