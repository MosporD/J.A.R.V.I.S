/**
 * Guarded access to localStorage.
 *
 * Reading `window.localStorage` is not merely unreliable, it is *throwing*
 * unreliable: a managed browser, a blocked-site-data policy or a private
 * window raises a SecurityError on the property access itself, before any key
 * is named. Anything that touches storage at module scope therefore takes the
 * whole bundle down with it, and a dashboard that cannot remember a volume
 * preference should still very much run.
 */

/** @returns {Storage|null} the store, or null when the browser withholds it. */
function store() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const storageAvailable = store() !== null;

export function readLocal(key, fallback = null) {
  try {
    return store()?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key, value) {
  try {
    store()?.setItem(key, value);
    return true;
  } catch {
    // Quota exhausted, or storage withheld — the caller carries on regardless.
    return false;
  }
}

export function readLocalJSON(key, fallback) {
  try {
    const raw = readLocal(key);
    return raw === null ? fallback : JSON.parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeLocalJSON(key, value) {
  try {
    return writeLocal(key, JSON.stringify(value));
  } catch {
    return false;
  }
}
