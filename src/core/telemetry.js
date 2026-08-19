import { bus } from './bus.js';
import { store, MODE } from './store.js';
import { ticker } from './ticker.js';
import { clamp } from './format.js';

/**
 * The diagnostic sampler.
 *
 * Where the browser exposes a real signal we use it — measured frame rate,
 * JS heap, hardware concurrency, network downlink, battery. The rest is a
 * smoothed random walk that responds to what J.A.R.V.I.S. is actually doing:
 * processing a command really does drive the CPU trace up.
 */

/** Fixed-length history. Cheap to push, cheap for a renderer to walk. */
export class Ring {
  constructor(size, fill = 0) {
    this.size = size;
    this.data = new Float32Array(size).fill(fill);
    this.index = 0;
  }

  push(value) {
    this.data[this.index] = value;
    this.index = (this.index + 1) % this.size;
  }

  /** Oldest -> newest. */
  toArray(out = new Float32Array(this.size)) {
    const { data, size, index } = this;
    for (let i = 0; i < size; i += 1) out[i] = data[(index + i) % size];
    return out;
  }

  get last() {
    return this.data[(this.index - 1 + this.size) % this.size];
  }

  get max() {
    let m = -Infinity;
    for (let i = 0; i < this.size; i += 1) if (this.data[i] > m) m = this.data[i];
    return m;
  }

  get mean() {
    let sum = 0;
    for (let i = 0; i < this.size; i += 1) sum += this.data[i];
    return sum / this.size;
  }
}

const HISTORY = 96;
const SAMPLE_HZ = 4;

/** How long a hand-raised alert keeps the interface on edge. */
const MANUAL_ALERT_MS = 20000;

/**
 * Each channel walks toward a drifting target instead of jumping, so the
 * sparklines read as instrumentation rather than noise.
 */
class Channel {
  constructor({ id, label, unit, base, spread, drift = 0.12, min = 0, max = 100 }) {
    Object.assign(this, { id, label, unit, base, spread, drift, min, max });
    this.value = base;
    this.target = base;
    this.history = new Ring(HISTORY, base);
    this.load = 0; // transient pressure added by activity

    // Open with a plausible past. A trace that starts as a flat line and
    // slowly fills from the left reads as a bug, not as instrumentation.
    let seed = base;
    for (let i = 0; i < HISTORY; i += 1) {
      seed = clamp(seed + (base - seed) * 0.18 + (Math.random() - 0.5) * spread * 0.7,
        this.min, this.max);
      this.history.push(seed);
    }
    this.value = seed;
  }

  step() {
    if (Math.random() < this.drift) {
      this.target = this.base + (Math.random() - 0.5) * 2 * this.spread;
    }
    // Rare spike — keeps the traces from feeling metronomic.
    if (Math.random() < 0.012) this.target += this.spread * 1.8;

    const pull = this.target + this.load * (this.max - this.base) * 0.55;
    this.value = clamp(this.value + (pull - this.value) * 0.28, this.min, this.max);
    this.load *= 0.86;
    this.history.push(this.value);
    return this.value;
  }

  /** Push the channel upward for a moment — used when the AI is working. */
  stress(amount = 1) {
    this.load = clamp(this.load + amount, 0, 1.6);
  }
}

class Telemetry {
  constructor() {
    this.channels = new Map(
      [
        { id: 'cpu', label: 'CPU LOAD', unit: '%', base: 34, spread: 11 },
        { id: 'mem', label: 'MEMORY', unit: '%', base: 58, spread: 7, drift: 0.08 },
        { id: 'gpu', label: 'GPU / RENDER', unit: '%', base: 42, spread: 14 },
        { id: 'net', label: 'UPLINK', unit: 'MB/S', base: 120, spread: 60, max: 400, drift: 0.2 },
        { id: 'pwr', label: 'ARC OUTPUT', unit: '%', base: 92, spread: 4, drift: 0.06 },
        { id: 'thm', label: 'CORE TEMP', unit: '°C', base: 41, spread: 6, max: 95 },
      ].map((spec) => [spec.id, new Channel(spec)]),
    );

    this.hardware = {
      cores: navigator.hardwareConcurrency || 8,
      memoryGB: navigator.deviceMemory || null,
      platform: navigator.userAgentData?.platform || navigator.platform || 'UNKNOWN',
      downlink: navigator.connection?.downlink ?? null,
      effectiveType: navigator.connection?.effectiveType ?? null,
    };
    this.battery = null;
    this.fps = 60;
    this.heap = null;

    this._accum = 0;
    this._raised = new Set();
    this._manual = null;
  }

  start() {
    // Real battery telemetry where the browser offers it.
    navigator.getBattery?.().then((b) => {
      const read = () => {
        this.battery = { level: b.level, charging: b.charging };
      };
      read();
      b.addEventListener('levelchange', read);
      b.addEventListener('chargingchange', read);
    }).catch(() => {});

    // An alert raised by hand (or by a diagnostic sweep) colours the interface
    // too, for a while. Without this the threat state would be recomputed from
    // the thresholds a quarter-second later and the alert would vanish.
    bus.on('alert', ({ level, source }) => {
      if (this.channels.has(source)) return; // threshold alerts are handled below
      this._manual = { level, until: Date.now() + MANUAL_ALERT_MS };
    });

    // Working state costs cycles — reflect that in the traces.
    store.watch('mode', (mode) => {
      if (mode === MODE.PROCESSING) {
        this.channels.get('cpu').stress(0.9);
        this.channels.get('gpu').stress(0.5);
        this.channels.get('net').stress(0.7);
      } else if (mode === MODE.SPEAKING) {
        this.channels.get('cpu').stress(0.35);
      }
    }, false);

    this.stop = ticker.add((dt) => {
      this._accum += dt;
      if (this._accum < 1 / SAMPLE_HZ) return;
      this._accum = 0;
      this.sample();
    });

    return this;
  }

  sample() {
    this.fps = ticker.fps;

    // Chrome exposes a real heap reading; prefer it over the simulated channel.
    const heap = performance.memory;
    if (heap) {
      this.heap = { used: heap.usedJSHeapSize, limit: heap.jsHeapSizeLimit };
      const ratio = (heap.usedJSHeapSize / heap.jsHeapSizeLimit) * 100;
      const mem = this.channels.get('mem');
      // Blend: the real signal barely moves, so keep some synthetic texture.
      mem.base = clamp(38 + ratio * 1.4, 20, 88);
    }

    const metrics = {};
    for (const [id, channel] of this.channels) {
      metrics[id] = channel.step();
    }

    // Keep the reactor readout and the arc output channel in agreement.
    store.set('reactor', Math.round(metrics.pwr));

    this.evaluate(metrics);
    bus.emit('telemetry', { metrics, channels: this.channels, self: this });
  }

  /** Threshold watch — the only source of automatic alerts. */
  evaluate(metrics) {
    const rules = [
      ['cpu', 88, 'warn', 'CPU LOAD ABOVE SAFE ENVELOPE'],
      ['thm', 74, 'warn', 'CORE TEMPERATURE RISING'],
      ['mem', 90, 'warn', 'MEMORY PRESSURE CRITICAL'],
      ['pwr', 70, 'alert', 'ARC OUTPUT BELOW MINIMUM', true],
    ];

    for (const [id, limit, level, title, below] of rules) {
      const breached = below ? metrics[id] < limit : metrics[id] > limit;
      const key = `${id}:${level}`;
      if (breached && !this._raised.has(key)) {
        this._raised.add(key);
        bus.emit('alert', {
          level,
          title,
          note: `${this.channels.get(id).label} ${metrics[id].toFixed(1)}${this.channels.get(id).unit}`,
          source: id,
        });
      } else if (!breached) {
        this._raised.delete(key);
      }
    }

    if (this._manual && Date.now() > this._manual.until) this._manual = null;

    const critical =
      this._manual?.level === 'alert' || [...this._raised].some((k) => k.endsWith('alert'));
    const elevated = Boolean(this._manual) || this._raised.size > 0;
    store.set('threat', critical ? 'critical' : elevated ? 'elevated' : 'nominal');
  }

  get(id) {
    return this.channels.get(id);
  }

  /** Snapshot for the `status` command. */
  snapshot() {
    const out = {};
    for (const [id, channel] of this.channels) {
      out[id] = { label: channel.label, value: channel.value, unit: channel.unit };
    }
    return out;
  }
}

export const telemetry = new Telemetry();
