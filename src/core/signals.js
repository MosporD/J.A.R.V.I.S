import { store } from './store.js';
import { history } from './history.js';
import { telemetry } from './telemetry.js';
import { ticker } from './ticker.js';

/**
 * The signal registry — and, more to the point, where each number comes from.
 *
 * Most of this dashboard's traces are a smoothed random walk. That is fine for
 * an instrument that is being watched, and completely unacceptable as the basis
 * for an alert: a watcher that fires on synthetic data is an elaborate random
 * number generator with a siren attached.
 *
 * So every signal declares its provenance, and anything raised against it
 * inherits that. An operator can then tell at a glance whether J.A.R.V.I.S. is
 * reporting the machine or reporting its own imagination — and when a real feed
 * is wired in, the watchers above do not change at all; only this table does.
 */

export const PROVENANCE = {
  MEASURED: 'measured',   // read from the platform
  BLENDED: 'blended',     // a real reading with synthetic texture over it
  SIMULATED: 'simulated', // invented, for the look of the thing
};

const registry = new Map();

/**
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.label
 * @param {string} spec.unit
 * @param {string} spec.provenance  one of PROVENANCE
 * @param {() => (number|null)} spec.read  current value, or null when unavailable
 * @param {string} [spec.note]  why it is what it is
 */
export function registerSignal(spec) {
  registry.set(spec.id, { unit: '', note: '', ...spec });
  return spec.id;
}

/** Remove a signal — a metric you stop tracking must stop being readable. */
export function unregisterSignal(id) {
  return registry.delete(id);
}

export function signal(id) {
  return registry.get(id) ?? null;
}

export function signals() {
  return [...registry.values()];
}

export function readSignal(id) {
  const entry = registry.get(id);
  if (!entry) return null;
  try {
    const value = entry.read();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** True when a signal reflects something real about the machine. */
export function isMeasured(id) {
  const entry = registry.get(id);
  return entry?.provenance === PROVENANCE.MEASURED;
}

// --- The channels the telemetry sampler already walks -------------------------

const CHANNEL_PROVENANCE = {
  cpu: [PROVENANCE.SIMULATED, 'No browser API reports host CPU. This is a random walk that responds to what the interface is doing.'],
  gpu: [PROVENANCE.SIMULATED, 'No browser API reports GPU load.'],
  net: [PROVENANCE.SIMULATED, 'Throughput is invented; navigator.connection.downlink is the real, much coarser figure.'],
  pwr: [PROVENANCE.SIMULATED, 'There is no arc reactor.'],
  thm: [PROVENANCE.SIMULATED, 'No browser API reports die temperature.'],
  mem: [PROVENANCE.BLENDED, 'Driven by performance.memory where Chrome exposes it, with synthetic texture over the top.'],
};

for (const [id, [provenance, note]] of Object.entries(CHANNEL_PROVENANCE)) {
  registerSignal({
    id,
    label: telemetry.get(id)?.label ?? id.toUpperCase(),
    unit: telemetry.get(id)?.unit ?? '',
    provenance,
    note,
    read: () => telemetry.get(id)?.value ?? null,
  });
}

// --- Signals that are genuinely measured --------------------------------------

registerSignal({
  id: 'fps',
  label: 'FRAME RATE',
  unit: 'FPS',
  provenance: PROVENANCE.MEASURED,
  note: 'Measured from the shared render loop.',
  read: () => ticker.fps,
});

registerSignal({
  id: 'heap',
  label: 'JS HEAP',
  unit: '%',
  provenance: PROVENANCE.MEASURED,
  note: 'performance.memory — Chromium only.',
  read: () => {
    const heap = telemetry.heap;
    return heap ? (heap.used / heap.limit) * 100 : null;
  },
});

registerSignal({
  id: 'battery',
  label: 'POWER CELL',
  unit: '%',
  provenance: PROVENANCE.MEASURED,
  note: 'navigator.getBattery — not offered by every browser.',
  read: () => (telemetry.battery ? telemetry.battery.level * 100 : null),
});

registerSignal({
  id: 'downlink',
  label: 'DOWNLINK',
  unit: 'MB/S',
  provenance: PROVENANCE.MEASURED,
  note: 'navigator.connection.downlink — coarse, and rounded by the browser.',
  read: () => navigator.connection?.downlink ?? null,
});

registerSignal({
  id: 'online',
  label: 'CONNECTIVITY',
  unit: '',
  provenance: PROVENANCE.MEASURED,
  note: 'The real online/offline state.',
  read: () => (store.get('online') ? 1 : 0),
});


/**
 * Write measured signals into the history store on a slow cadence.
 *
 * Deliberately slow, and deliberately measured-only. A sample a minute is
 * plenty to see a day's shape, and recording the synthetic channels would fill
 * the database with a random walk — expensive noise that makes every later
 * query slower without making any answer truer.
 */
const RECORD_EVERY_MS = 60_000;

export function startSignalRecorder({ everyMs = RECORD_EVERY_MS } = {}) {
  const tick = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    for (const source of registry.values()) {
      if (source.provenance !== PROVENANCE.MEASURED) continue;
      const value = readSignal(source.id);
      if (value !== null) history.append(source.id, value);
    }
  };
  tick();
  const id = setInterval(tick, everyMs);
  return () => clearInterval(id);
}
