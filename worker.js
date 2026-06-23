/**
 * VRT — Video Runtime Tracker
 * Web Worker: handles all IndexedDB read/write operations off the main thread.
 *
 * Stores:
 *   scans   — { id, folderName, timestamp, totalDuration, fileCount, failedCount, hasHandle, files[] }
 *   handles — { scanId, handle: FileSystemDirectoryHandle }
 */

const DB_NAME    = 'vrt-db';
const DB_VERSION = 1;

let db = null;

// ── IndexedDB bootstrap ────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = ({ target }) => {
      const d = target.result;
      if (!d.objectStoreNames.contains('scans'))
        d.createObjectStore('scans',   { keyPath: 'id' });
      if (!d.objectStoreNames.contains('handles'))
        d.createObjectStore('handles', { keyPath: 'scanId' });
    };

    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function getDB() {
  if (!db) db = await openDB();
  return db;
}

// ── Store operations ───────────────────────────────────────────────────────

const store = {
  async getAllScans() {
    const d   = await getDB();
    const req = d.transaction('scans', 'readonly').objectStore('scans').getAll();
    return new Promise((res, rej) => {
      req.onsuccess = e => res([...e.target.result].reverse()); // newest first
      req.onerror   = e => rej(e.target.error);
    });
  },

  async putScan(scan) {
    const d = await getDB();
    const req = d.transaction('scans', 'readwrite').objectStore('scans').put(scan);
    return new Promise((res, rej) => {
      req.onsuccess = res;
      req.onerror   = e => rej(e.target.error);
    });
  },

  async deleteScanAndHandle(id) {
    const d  = await getDB();
    const tx = d.transaction(['scans', 'handles'], 'readwrite');
    tx.objectStore('scans').delete(id);
    tx.objectStore('handles').delete(id);
    return new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
  },

  async clearAll() {
    const d  = await getDB();
    const tx = d.transaction(['scans', 'handles'], 'readwrite');
    tx.objectStore('scans').clear();
    tx.objectStore('handles').clear();
    return new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
  },

  async putHandle(scanId, handle) {
    const d   = await getDB();
    const req = d.transaction('handles', 'readwrite').objectStore('handles').put({ scanId, handle });
    return new Promise((res, rej) => {
      req.onsuccess = res;
      req.onerror   = e => rej(e.target.error);
    });
  },

  async getHandle(scanId) {
    const d   = await getDB();
    const req = d.transaction('handles', 'readonly').objectStore('handles').get(scanId);
    return new Promise((res, rej) => {
      req.onsuccess = e => res(e.target.result?.handle ?? null);
      req.onerror   = e => rej(e.target.error);
    });
  },
};

// ── Message handler ────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  try {
    switch (data.type) {

      case 'load': {
        const scans = await store.getAllScans();
        self.postMessage({ type: 'history', scans });
        break;
      }

      case 'save': {
        await store.putScan(data.scan);
        const scans = await store.getAllScans();
        self.postMessage({ type: 'history', scans }); // broadcast fresh list
        break;
      }

      case 'saveHandle': {
        await store.putHandle(data.scanId, data.handle);
        break;
      }

      case 'loadHandle': {
        const handle = await store.getHandle(data.scanId);
        self.postMessage({ type: 'handle', scanId: data.scanId, handle });
        break;
      }

      case 'delete': {
        await store.deleteScanAndHandle(data.id);
        const scans = await store.getAllScans();
        self.postMessage({ type: 'history', scans });
        break;
      }

      case 'clear': {
        await store.clearAll();
        self.postMessage({ type: 'history', scans: [] });
        break;
      }

      default:
        console.warn('[VRT Worker] Unknown message type:', data.type);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
