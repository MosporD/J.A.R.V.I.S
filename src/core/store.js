import { bus } from './bus.js';

/**
 * The single source of runtime truth. Small, flat and observable — panels
 * subscribe to the keys they care about instead of polling each other.
 */

/** The four things J.A.R.V.I.S. can be doing at any moment. */
export const MODE = {
  IDLE: 'idle',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  SPEAKING: 'speaking',
};

const state = {
  mode: MODE.IDLE,
  booted: false,
  online: navigator.onLine,
  sfx: true,
  mic: false,
  voice: true,
  reduceMotion: false,
  threat: 'nominal',      // nominal | elevated | critical
  reactor: 92,            // core output %
  amplitude: 0,           // 0..1 — drives the waveform and core bloom
  coordinates: null,      // { lat, lon, label } once located
  startedAt: Date.now(),
};

const watchers = new Map();

export const store = {
  /** Read a key, or the whole (frozen) state when called with no argument. */
  get(key) {
    return key === undefined ? { ...state } : state[key];
  },

  /** Write one key or merge a patch. No-ops when the value is unchanged. */
  set(keyOrPatch, maybeValue) {
    const patch =
      typeof keyOrPatch === 'string' ? { [keyOrPatch]: maybeValue } : keyOrPatch;

    for (const [key, value] of Object.entries(patch)) {
      const prev = state[key];
      if (Object.is(prev, value)) continue;
      state[key] = value;
      watchers.get(key)?.forEach((fn) => fn(value, prev));
      bus.emit('state:change', { key, value, prev });
    }
  },

  /** Subscribe to one key. Fires immediately unless `eager` is false. */
  watch(key, handler, eager = true) {
    if (!watchers.has(key)) watchers.set(key, new Set());
    watchers.get(key).add(handler);
    if (eager) handler(state[key], undefined);
    return () => watchers.get(key)?.delete(handler);
  },

  /** Seconds since boot — used by the status bar and the `uptime` command. */
  uptime() {
    return Math.floor((Date.now() - state.startedAt) / 1000);
  },
};

// Connectivity is real, not simulated.
window.addEventListener('online', () => store.set('online', true));
window.addEventListener('offline', () => store.set('online', false));
