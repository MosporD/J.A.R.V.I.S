import { storageAvailable } from './storage.js';

/**
 * Durable time series for signals.
 *
 * Everything the sentinel could reason about until now lived in memory and died
 * with the tab, which caps its intelligence at "what happened in the last few
 * seconds". A console that is meant to notice a trend across a week has to
 * remember a week.
 *
 * IndexedDB rather than localStorage: this is thousands of rows, it wants an
 * index on (signal, at), and localStorage is a synchronous string store with a
 * 5 MB cliff. Every call degrades to an in-memory store when the database is
 * unavailable — a private window, a blocked-storage policy, or a browser that
 * simply refuses — so callers never have to care.
 */

const DB_NAME = 'jarvis-history';
const STORE = 'samples';
const VERSION = 1;

/** Keep three months. Long enough for a seasonal read, short enough to stay fast. */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

let dbPromise = null;
/** Fallback when IndexedDB is unavailable: same shape, no durability. */
const memory = new Map();

function open() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (!storageAvailable || typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('signal_at', ['signal', 'at']);
        store.createIndex('at', 'at');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // A blocked upgrade would otherwise hang every caller forever.
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function memoryAppend(signal, sample) {
  const list = memory.get(signal) ?? [];
  list.push(sample);
  // Bounded, so a long session cannot exhaust the tab.
  memory.set(signal, list.slice(-5000));
}

export const history = {
  /** Record one reading. Never throws. */
  async append(signal, value, at = Date.now(), meta = null) {
    if (!Number.isFinite(value)) return false;
    const sample = { signal, value, at, ...(meta ? { meta } : {}) };

    const db = await open();
    if (!db) {
      memoryAppend(signal, sample);
      return false;
    }
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).add(sample);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return true;
    } catch {
      memoryAppend(signal, sample);
      return false;
    }
  },

  /** Oldest to newest. */
  async series(signal, { since = 0, until = Date.now(), limit = 5000 } = {}) {
    const db = await open();
    if (!db) {
      return (memory.get(signal) ?? [])
        .filter((s) => s.at >= since && s.at <= until)
        .slice(-limit);
    }
    try {
      return await new Promise((resolve, reject) => {
        const out = [];
        const tx = db.transaction(STORE, 'readonly');
        const index = tx.objectStore(STORE).index('signal_at');
        const range = IDBKeyRange.bound([signal, since], [signal, until]);
        const cursorRequest = index.openCursor(range);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || out.length >= limit) {
            resolve(out);
            return;
          }
          out.push(cursor.value);
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
      });
    } catch {
      return [];
    }
  },

  async latest(signal) {
    const series = await this.series(signal, { limit: 5000 });
    return series.length ? series[series.length - 1] : null;
  },

  /** Enough of a summary to answer "is this normal?" without loading the series twice. */
  async stats(signal, { since = 0 } = {}) {
    const series = await this.series(signal, { since });
    if (!series.length) return null;

    const values = series.map((s) => s.value).sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const mid = Math.floor(values.length / 2);

    return {
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      mean: sum / values.length,
      median: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2,
      first: series[0],
      last: series[series.length - 1],
      span: series[series.length - 1].at - series[0].at,
    };
  },

  /** Change per day across the window — the shape a life console actually asks about. */
  async slope(signal, { since = 0 } = {}) {
    const series = await this.series(signal, { since });
    if (series.length < 2) return null;
    const first = series[0];
    const last = series[series.length - 1];
    const days = (last.at - first.at) / 86_400_000;
    if (days <= 0) return null;
    return (last.value - first.value) / days;
  },

  async prune(before = Date.now() - RETENTION_MS) {
    const db = await open();
    if (!db) {
      for (const [signal, list] of memory) {
        memory.set(signal, list.filter((s) => s.at >= before));
      }
      return 0;
    }
    try {
      return await new Promise((resolve, reject) => {
        let removed = 0;
        const tx = db.transaction(STORE, 'readwrite');
        const index = tx.objectStore(STORE).index('at');
        const cursorRequest = index.openCursor(IDBKeyRange.upperBound(before));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          cursor.delete();
          removed += 1;
          cursor.continue();
        };
        tx.oncomplete = () => resolve(removed);
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      return 0;
    }
  },

  /** Every signal id that has ever been recorded. */
  async tracked() {
    const db = await open();
    if (!db) return [...memory.keys()];
    try {
      return await new Promise((resolve, reject) => {
        const seen = new Set();
        const tx = db.transaction(STORE, 'readonly');
        const cursorRequest = tx.objectStore(STORE).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            resolve([...seen]);
            return;
          }
          seen.add(cursor.value.signal);
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
      });
    } catch {
      return [];
    }
  },

  /** Testing seam, and a genuine "forget this" for the operator. */
  async clear(signal = null) {
    const db = await open();
    if (!db) {
      signal ? memory.delete(signal) : memory.clear();
      return;
    }
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        if (!signal) {
          store.clear();
        } else {
          const range = IDBKeyRange.bound([signal, 0], [signal, Infinity]);
          const cursorRequest = store.index('signal_at').openCursor(range);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            cursor.delete();
            cursor.continue();
          };
        }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* nothing to clear */
    }
  },
};
