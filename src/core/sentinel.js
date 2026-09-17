import { bus } from './bus.js';
import { store } from './store.js';
import { readSignal, signal, PROVENANCE } from './signals.js';
import { readLocalJSON, writeLocalJSON } from './storage.js';

/**
 * The sentinel — watching, so the operator does not have to.
 *
 * The threshold check this replaces fired the instant a single sample crossed a
 * line, which is the cheapest possible way to be wrong in both directions: a
 * one-frame spike raised an alarm, and a channel sitting a hair under the limit
 * for an hour raised nothing. Worse, it re-fired the moment a flapping value
 * re-crossed, so the one condition guaranteed to produce the most noise was the
 * one nobody should be woken for.
 *
 * What a watcher actually needs:
 *
 *   sustain     a condition must hold for a while before it counts
 *   hysteresis  it clears at a different value than it fires at, or it flaps
 *   cooldown    having been told once, you are not told again immediately
 *   memory      a reload is not a reason to re-raise everything
 *   provenance  an alert inherits the honesty of the signal beneath it
 *
 * Rules are data, so a rule over a real KPI feed and a rule over a random walk
 * are the same object with a different `signal`.
 */

const STORAGE_KEY = 'jarvis.sentinel';
const EVAL_INTERVAL_MS = 1000;

/** How long a hand-raised alert keeps the interface on edge. */
const MANUAL_ALERT_MS = 20000;

/** Comparators. Each answers: is the condition true right now? */
const OPERATORS = {
  above: (value, rule) => value > rule.value,
  below: (value, rule) => value < rule.value,
  equals: (value, rule) => value === rule.value,
};

/** Clear thresholds sit inside the fire threshold by this much, when unstated. */
const DEFAULT_HYSTERESIS = 0.08;

export class Sentinel {
  constructor() {
    this.rules = new Map();
    this.state = new Map();      // per-rule runtime: since, active, lastFired
    this.history = [];           // what fired, for the digest
    this.enabled = true;
    this.timer = null;
    this.manual = null;          // an alert raised by hand, not by a rule
    this._restore();
  }

  /**
   * @param {object} rule
   * @param {string} rule.id
   * @param {string} rule.label        shown when it fires
   * @param {string} rule.signal       a registered signal id
   * @param {'above'|'below'|'equals'|'trend'|'stale'} rule.op
   * @param {number} [rule.value]      threshold
   * @param {number} [rule.for]        seconds the condition must hold
   * @param {number} [rule.clearAt]    value it must return past to clear
   * @param {number} [rule.cooldown]   seconds before it may fire again
   * @param {'warn'|'alert'} [rule.severity]
   * @param {string} [rule.advice]     what to do about it
   * @param {boolean} [rule.armed]
   */
  add(rule) {
    const full = {
      severity: 'warn',
      for: 10,
      cooldown: 300,
      armed: true,
      advice: '',
      ...rule,
    };
    this.rules.set(full.id, full);
    if (!this.state.has(full.id)) {
      this.state.set(full.id, { since: null, active: false, lastFired: 0 });
    }
    return full;
  }

  remove(id) {
    this.rules.delete(id);
    this.state.delete(id);
  }

  list() {
    return [...this.rules.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  arm(id, armed = true) {
    const rule = this.rules.get(id);
    if (!rule) return false;
    rule.armed = armed;
    if (!armed) this._reset(id);
    this._persist();
    return true;
  }

  start() {
    if (this.timer) return this;

    // A sweep or a hand-raised alert colours the interface too, for a while.
    // Rules raise through the same channel, so they are tagged and skipped here.
    bus.on('alert', (alert) => {
      if (alert.fromSentinel) return;
      this.manual = { level: alert.level, until: Date.now() + MANUAL_ALERT_MS };
    });

    this.timer = setInterval(() => this.evaluate(), EVAL_INTERVAL_MS);
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _reset(id) {
    const state = this.state.get(id);
    if (state) {
      state.since = null;
      state.active = false;
    }
  }

  /** One pass over every armed rule. */
  evaluate(now = Date.now()) {
    if (!this.enabled) return;

    for (const rule of this.rules.values()) {
      const state = this.state.get(rule.id);
      if (!rule.armed) continue;

      const value = readSignal(rule.signal);
      const breached = this._test(rule, value, now);

      if (breached) {
        if (state.since === null) state.since = now;
        const heldFor = (now - state.since) / 1000;
        const cooled = (now - state.lastFired) / 1000 >= rule.cooldown;

        if (!state.active && heldFor >= rule.for && cooled) {
          state.active = true;
          state.lastFired = now;
          this._raise(rule, value, heldFor);
          this._persist();
        }
        continue;
      }

      // Not breached. Only clear once the value is back past the clear point,
      // so a value hovering on the threshold does not chatter.
      if (state.active && this._cleared(rule, value)) {
        state.active = false;
        state.since = null;
        this._clear(rule, value);
        this._persist();
      } else if (!state.active) {
        state.since = null;
      }
    }

    this._publishThreat();
  }

  _test(rule, value, now) {
    if (rule.op === 'stale') {
      // A signal that has stopped reporting is itself the condition.
      return value === null;
    }
    if (value === null) return false;

    if (rule.op === 'trend') {
      const previous = this._trend ??= new Map();
      const last = previous.get(rule.id);
      previous.set(rule.id, { value, at: now });
      if (!last) return false;
      const seconds = (now - last.at) / 1000;
      if (seconds <= 0) return false;
      const perMinute = ((value - last.value) / seconds) * 60;
      return rule.value >= 0 ? perMinute >= rule.value : perMinute <= rule.value;
    }

    const operator = OPERATORS[rule.op];
    return operator ? operator(value, rule) : false;
  }

  /** Hysteresis: clearing takes more than merely not breaching. */
  _cleared(rule, value) {
    if (rule.op === 'stale') return value !== null;
    if (value === null) return false;
    if (rule.op === 'trend' || rule.op === 'equals') return true;

    const margin = Math.abs(rule.value) * DEFAULT_HYSTERESIS;
    const clearAt = rule.clearAt ?? (rule.op === 'above' ? rule.value - margin : rule.value + margin);
    return rule.op === 'above' ? value < clearAt : value > clearAt;
  }

  _raise(rule, value, heldFor) {
    const source = signal(rule.signal);
    const simulated = source?.provenance !== PROVENANCE.MEASURED;
    const reading = value === null
      ? 'no reading'
      : `${value.toFixed(1)}${source?.unit ?? ''}`;

    const event = {
      id: rule.id,
      level: rule.severity,
      title: rule.label,
      note: `${source?.label ?? rule.signal} ${reading} · held ${Math.round(heldFor)}s`,
      source: rule.signal,
      simulated,
      advice: rule.advice,
      at: Date.now(),
    };

    this.history.unshift(event);
    this.history = this.history.slice(0, 40);

    bus.emit('sentinel:raise', event);
    bus.emit('alert', {
      level: event.level,
      title: event.title,
      // Say so, in the alert itself, when the number underneath is invented.
      note: simulated ? `${event.note} · SIMULATED SIGNAL` : event.note,
      source: event.source,
      fromSentinel: true,
    });
    if (rule.advice) {
      bus.emit('log', { level: 'sys', tag: 'sentinel', text: `↳ ${rule.advice}` });
    }
  }

  _clear(rule, value) {
    const source = signal(rule.signal);
    bus.emit('sentinel:clear', { id: rule.id, label: rule.label, value });
    bus.emit('log', {
      level: 'ok',
      tag: 'sentinel',
      text: `${rule.label} — recovered${
        value === null ? '' : ` at ${value.toFixed(1)}${source?.unit ?? ''}`
      }.`,
    });
  }

  /**
   * Active rules, plus anything raised by hand, decide the interface's posture.
   *
   * This used to live in the telemetry sampler, recomputed from bare thresholds
   * four times a second — which is why a hand-raised alert needed a timer to
   * survive being overwritten a quarter-second later. Here the two sources are
   * simply combined.
   */
  _publishThreat() {
    const active = [...this.rules.values()].filter((r) => this.state.get(r.id)?.active);

    if (this.manual && Date.now() > this.manual.until) this.manual = null;

    const critical =
      this.manual?.level === 'alert' || active.some((rule) => rule.severity === 'alert');
    const elevated = Boolean(this.manual) || active.length > 0;

    store.set('sentinelActive', active.length);
    store.set('threat', critical ? 'critical' : elevated ? 'elevated' : 'nominal');
    return active;
  }

  activeSeverities() {
    return [...this.rules.values()]
      .filter((rule) => this.state.get(rule.id)?.active)
      .map((rule) => rule.severity);
  }

  /** What fired while nobody was looking. */
  digest({ since = 0 } = {}) {
    return this.history.filter((entry) => entry.at > since);
  }

  /**
   * Only `lastFired` survives a reload — deliberately.
   *
   * Persisting `active` would resurrect an alert for a condition that may have
   * cleared while the tab was shut; persisting `lastFired` is what stops a
   * refresh from re-announcing everything it told you a minute ago.
   */
  _persist() {
    const fired = {};
    for (const [id, state] of this.state) {
      if (state.lastFired) fired[id] = state.lastFired;
    }
    writeLocalJSON(STORAGE_KEY, { fired, armed: this._armedMap() });
  }

  _armedMap() {
    const armed = {};
    for (const rule of this.rules.values()) armed[rule.id] = rule.armed;
    return armed;
  }

  _restore() {
    this._saved = readLocalJSON(STORAGE_KEY, { fired: {}, armed: {} }) || { fired: {}, armed: {} };
  }

  /** Called once the default rules are in place. */
  applySaved() {
    const { fired = {}, armed = {} } = this._saved || {};
    for (const [id, at] of Object.entries(fired)) {
      const state = this.state.get(id);
      if (state) state.lastFired = at;
    }
    for (const [id, isArmed] of Object.entries(armed)) {
      const rule = this.rules.get(id);
      if (rule) rule.armed = Boolean(isArmed);
    }
  }
}

export const sentinel = new Sentinel();
