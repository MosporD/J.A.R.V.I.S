import { bus } from './bus.js';
import { history } from './history.js';
import { registerSignal, unregisterSignal, PROVENANCE } from './signals.js';
import { readLocalJSON, writeLocalJSON } from './storage.js';
import { register, log, respond } from './commands.js';

/**
 * Metrics you keep by hand.
 *
 * The numbers that actually run a life — cash in the account, weight, hours
 * billed, subscribers, the thing you promised yourself you would do daily —
 * mostly have no API, and the ones that do are behind an OAuth dance nobody
 * wants at nine in the evening. A console that can only show what it can scrape
 * is a console that shows the least important half of your life.
 *
 * So: type the number, and it becomes a first-class signal. Same registry the
 * measured channels use, same sentinel watching it, same trend maths, same
 * digest. `track cash 12500` is, from that moment on, indistinguishable from a
 * reading taken off the platform — because it is a real observation, which is
 * more than most of this dashboard's traces can say.
 */

const STORAGE_KEY = 'jarvis.tracked';
const PREFIX = 'track:';

/** Metric definitions. Values live in the history store, not here. */
let definitions = readLocalJSON(STORAGE_KEY, {}) || {};

function persist() {
  writeLocalJSON(STORAGE_KEY, definitions);
}

/** A metric id is a slug — it becomes a signal id and a storage key. */
export function slug(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function signalId(id) {
  return `${PREFIX}${id}`;
}

/** Make a tracked metric readable by the sentinel and everything else. */
function expose(id) {
  const definition = definitions[id];
  if (!definition) return;

  registerSignal({
    id: signalId(id),
    label: definition.label,
    unit: definition.unit || '',
    // A number a person typed is an observation of the real world. It is not
    // measured by the platform, but it is emphatically not invented either.
    provenance: PROVENANCE.MEASURED,
    note: `Recorded by hand. Last entry ${
      definition.lastAt ? new Date(definition.lastAt).toISOString().slice(0, 16).replace('T', ' ') : 'never'
    }.`,
    // Resolved on every read rather than captured: a closure over the
    // definition object would keep reporting a forgotten metric's last value
    // for the life of the session.
    read: () => {
      const current = definitions[id];
      return current && Number.isFinite(current.last) ? current.last : null;
    },
  });
}

export function trackedMetrics() {
  return Object.entries(definitions)
    .map(([id, definition]) => ({ id, ...definition }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function isTracked(id) {
  return Boolean(definitions[id]);
}

/** Record a reading, creating the metric on first use. */
export async function record(name, value, { unit = '', at = Date.now(), note = '' } = {}) {
  const id = slug(name);
  if (!id) throw new Error('a metric needs a name');
  if (!Number.isFinite(value)) throw new Error(`"${value}" is not a number`);

  const existing = definitions[id];
  definitions[id] = {
    label: existing?.label ?? String(name).trim().toUpperCase(),
    unit: unit || existing?.unit || '',
    goal: existing?.goal ?? null,          // 'up' | 'down' — which way is good
    last: value,
    lastAt: at,
    count: (existing?.count ?? 0) + 1,
    createdAt: existing?.createdAt ?? at,
  };
  persist();
  expose(id);

  await history.append(signalId(id), value, at, note ? { note } : null);
  bus.emit('track:record', { id, value, at, unit: definitions[id].unit });
  return { id, ...definitions[id] };
}

export function forget(name) {
  const id = slug(name);
  if (!definitions[id]) return false;
  delete definitions[id];
  persist();
  // Both halves matter: the signal must leave the registry, and its samples
  // must leave the history store, or "forget" is only a rename.
  unregisterSignal(signalId(id));
  history.clear(signalId(id));
  bus.emit('track:forget', { id });
  return true;
}

/** Re-register every known metric so the signal registry survives a reload. */
export function restoreTracked() {
  Object.keys(definitions).forEach(expose);
  return Object.keys(definitions).length;
}

// --- Directives --------------------------------------------------------------

function formatValue(value, unit) {
  const rounded = Math.abs(value) >= 1000 ? value.toLocaleString() : String(value);
  return unit ? `${rounded} ${unit}` : rounded;
}

function ago(at) {
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

register({
  name: 'track',
  aliases: ['metric'],
  summary: 'Record a number by hand — track <name> <value> [unit] | list | show | goal | forget.',
  async run(args) {
    const verb = (args[0] || 'list').toLowerCase();

    if (verb === 'list' || !args.length) {
      const metrics = trackedMetrics();
      if (!metrics.length) {
        log('Nothing tracked yet. Try: track cash 12500 JOD', 'sys', 'track');
        return respond('You are not tracking anything yet, sir.');
      }
      log('TRACKED METRICS', 'ok', 'track');
      for (const metric of metrics) {
        log(
          `  ${metric.id.padEnd(16)} ${formatValue(metric.last, metric.unit).padStart(12)}   ${ago(metric.lastAt)}   ${metric.count} entr${metric.count === 1 ? 'y' : 'ies'}`,
          'sys',
          'track',
        );
      }
      return respond(`${metrics.length} metric${metrics.length === 1 ? '' : 's'} tracked, sir.`);
    }

    if (verb === 'goal') {
      const id = slug(args[1] || '');
      const want = (args[2] || '').toLowerCase();
      if (!definitions[id]) {
        log(`Not tracked: ${args[1]}`, 'warn', 'track');
        return Promise.resolve();
      }
      if (!['up', 'down', 'none'].includes(want)) {
        log('Usage: track goal <name> up | down | none', 'warn', 'track');
        return Promise.resolve();
      }
      // Which direction is good is yours to state. Nothing guesses it: up is
      // good for cash and bad for weight, and colouring one like the other is
      // worse than staying neutral.
      definitions[id].goal = want === 'none' ? null : want;
      persist();
      bus.emit('track:record', { id, value: definitions[id].last, at: Date.now() });
      log(
        want === 'none'
          ? `${definitions[id].label}: no direction preference.`
          : `${definitions[id].label}: ${want} is good.`,
        'ok',
        'track',
      );
      return Promise.resolve();
    }

    if (verb === 'forget') {
      const ok = forget(args[1] || '');
      log(ok ? `Forgotten: ${slug(args[1])}` : `Not tracked: ${args[1]}`, ok ? 'ok' : 'warn', 'track');
      return Promise.resolve();
    }

    if (verb === 'show') {
      const id = slug(args[1] || '');
      const definition = definitions[id];
      if (!definition) {
        log(`Not tracked: ${args[1]}`, 'warn', 'track');
        return Promise.resolve();
      }
      const week = Date.now() - 7 * 86_400_000;
      const stats = await history.stats(signalId(id), { since: 0 });
      const weekSlope = await history.slope(signalId(id), { since: week });

      log(`${definition.label}`, 'ok', 'track');
      log(`  now      ${formatValue(definition.last, definition.unit)}  (${ago(definition.lastAt)})`, 'sys', 'track');
      if (stats) {
        log(`  range    ${formatValue(stats.min, definition.unit)} … ${formatValue(stats.max, definition.unit)}`, 'sys', 'track');
        log(`  median   ${formatValue(Math.round(stats.median * 100) / 100, definition.unit)} over ${stats.count} entries`, 'sys', 'track');
      }
      if (weekSlope !== null) {
        const direction = weekSlope > 0 ? 'up' : 'down';
        log(`  trend    ${direction} ${formatValue(Math.abs(Math.round(weekSlope * 100) / 100), definition.unit)}/day over the last week`, 'sys', 'track');
      }
      return respond(`${definition.label} is ${formatValue(definition.last, definition.unit)}.`);
    }

    // track <name> <value> [unit...]
    const name = args[0];
    const value = Number.parseFloat(args[1]);
    if (!Number.isFinite(value)) {
      log('Usage: track <name> <value> [unit]   e.g. track cash 12500 JOD', 'warn', 'track');
      return respond('I need a number to record, sir.');
    }

    try {
      const metric = await record(name, value, { unit: args.slice(2).join(' ') });
      log(`${metric.label} = ${formatValue(metric.last, metric.unit)}`, 'ok', 'track');
      return respond(`Recorded. ${metric.label} is ${formatValue(metric.last, metric.unit)}.`);
    } catch (error) {
      log(`Could not record — ${error.message}`, 'alert', 'track');
      return Promise.resolve();
    }
  },
});
