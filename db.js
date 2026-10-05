// Captures are too big for chrome.storage; keep them as Blobs in IndexedDB.
const open = () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open('bloosnap', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('captures', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('captures', mode);
    const result = fn(t.objectStore('captures'));
    t.oncomplete = () => resolve(result.result);
    t.onerror = () => reject(t.error);
  });
};

export const saveCapture = (rec) => tx('readwrite', (s) => s.put(rec));
export const loadCapture = (id) => tx('readonly', (s) => s.get(id));
