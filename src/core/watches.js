import { sentinel } from './sentinel.js';
import { signal, PROVENANCE, signals } from './signals.js';
import { register, log, respond } from './commands.js';
import { slug } from './track.js';
import { readLocalJSON, writeLocalJSON } from './storage.js';
import { duration } from './format.js';

/**
 * The default watch set, and the directives that drive it.
 *
 * Thresholds here are deliberately conservative. A watcher earns its place by
 * being right when it speaks; one that cries wolf gets disarmed within a day
 * and then protects nothing.
 *
 * Note which rules sit on measured signals and which do not. The measured ones
 * are the only ones that can wake you by default — see notify.js.
 */

const DEFAULTS = [
  {
    id: 'frame-rate',
    label: 'INTERFACE DROPPING FRAMES',
    signal: 'fps',
    op: 'below',
    value: 24,
    for: 8,
    clearAt: 40,
    severity: 'warn',
    advice: 'Close the 3D core with a reload, or another tab is competing for the GPU.',
  },
  {
    id: 'heap-pressure',
    label: 'JS HEAP PRESSURE',
    signal: 'heap',
    op: 'above',
    value: 85,
    for: 20,
    severity: 'alert',
    advice: 'A leak, or a very long session. Reload before the tab is killed.',
  },
  {
    id: 'heap-climb',
    label: 'HEAP CLIMBING STEADILY',
    signal: 'heap',
    op: 'trend',
    value: 2.5,            // percentage points per minute, sustained
    for: 90,
    cooldown: 1800,
    severity: 'warn',
    advice: 'Consistent growth with no plateau is the shape of a leak.',
  },
  {
    id: 'battery-low',
    label: 'POWER CELL LOW',
    signal: 'battery',
    op: 'below',
    value: 15,
    for: 30,
    clearAt: 25,
    severity: 'alert',
    advice: 'Mains, sir.',
  },
  {
    id: 'offline',
    label: 'UPLINK LOST',
    signal: 'online',
    op: 'below',
    value: 1,
    for: 5,
    severity: 'alert',
    advice: 'Network is down. Anything fetched from here will fail until it returns.',
  },
  // Simulated channels. Kept so the watch list is populated and the mechanism
  // is visible, but they are marked as invented wherever they surface.
  {
    id: 'cpu-sustained',
    label: 'CPU LOAD SUSTAINED',
    signal: 'cpu',
    op: 'above',
    value: 88,
    for: 15,
    severity: 'warn',
    advice: 'Simulated channel — this is the mechanism, not a real reading.',
  },
  {
    id: 'core-temp',
    label: 'CORE TEMPERATURE RISING',
    signal: 'thm',
    op: 'above',
    value: 74,
    for: 20,
    severity: 'warn',
    advice: 'Simulated channel.',
  },
  {
    id: 'arc-output',
    label: 'ARC OUTPUT BELOW MINIMUM',
    signal: 'pwr',
    op: 'below',
    value: 70,
    for: 10,
    severity: 'alert',
    advice: 'Simulated channel.',
  },
];

const CUSTOM_KEY = 'jarvis.watches';

/** A threshold you set by hand must survive a reload; the defaults are code. */
function saveCustom() {
  const builtIn = new Set(DEFAULTS.map((rule) => rule.id));
  const custom = sentinel.list().filter((rule) => !builtIn.has(rule.id));
  writeLocalJSON(CUSTOM_KEY, custom);
}

export function installDefaultWatches() {
  DEFAULTS.forEach((rule) => sentinel.add(rule));
  const custom = readLocalJSON(CUSTOM_KEY, []);
  if (Array.isArray(custom)) custom.forEach((rule) => sentinel.add(rule));
  sentinel.applySaved();
  return sentinel;
}

/** A short provenance marker, so a reader always knows what they are looking at. */
function mark(signalId) {
  const source = signal(signalId);
  if (!source) return '?';
  if (source.provenance === PROVENANCE.MEASURED) return 'REAL';
  if (source.provenance === PROVENANCE.BLENDED) return 'PART';
  return 'SIM ';
}

register({
  name: 'watch',
  aliases: ['watches', 'sentinel'],
  summary: 'The sentinel — list | add | remove | arm | disarm | test | signals.',
  run(args) {
    const verb = (args[0] || 'list').toLowerCase();
    const id = args[1];

    if (verb === 'signals') {
      log('SIGNALS AND WHERE THEY COME FROM', 'ok', 'watch');
      for (const source of signals()) {
        const tag = source.provenance === PROVENANCE.MEASURED ? 'ok' : 'sys';
        log(`  ${mark(source.id)} ${source.id.padEnd(9)} ${source.label}`, tag, 'watch');
        if (source.note) log(`       ${source.note}`, 'sys', 'watch');
      }
      return respond('Signal provenance displayed, sir.');
    }

    if (verb === 'add') {
      // watch add <signal> above|below <value> [severity]
      const [, target, op, rawValue, severity = 'warn'] = args;
      const signalId = target?.startsWith('track:') || signal(target) ? target : `track:${slug(target || '')}`;

      if (!signal(signalId)) {
        log(`No signal called "${target}". Try: watch signals`, 'warn', 'watch');
        return Promise.resolve();
      }
      if (!['above', 'below'].includes(op)) {
        log('Usage: watch add <signal> above|below <value> [warn|alert]', 'warn', 'watch');
        return Promise.resolve();
      }
      const value = Number.parseFloat(rawValue);
      if (!Number.isFinite(value)) {
        log(`"${rawValue}" is not a number.`, 'warn', 'watch');
        return Promise.resolve();
      }

      const id = `${signalId.replace(/[^a-z0-9]+/gi, '-')}-${op}`.toLowerCase();
      const source = signal(signalId);
      sentinel.add({
        id,
        label: `${source.label} ${op.toUpperCase()} ${value}${source.unit ? ` ${source.unit}` : ''}`,
        signal: signalId,
        op,
        value,
        for: 0,
        cooldown: 3600,
        severity: severity === 'alert' ? 'alert' : 'warn',
        advice: 'Threshold you set.',
      });
      saveCustom();
      log(`Watching ${source.label} ${op} ${value}. Id: ${id}`, 'ok', 'watch');
      return respond(`I will tell you when ${source.label.toLowerCase()} goes ${op} ${value}.`);
    }

    if (verb === 'remove' || verb === 'delete') {
      if (!sentinel.rules.has(id)) {
        log(`No watch called "${id}".`, 'warn', 'watch');
        return Promise.resolve();
      }
      sentinel.remove(id);
      saveCustom();
      log(`Removed ${id}.`, 'ok', 'watch');
      return Promise.resolve();
    }

    if (verb === 'arm' || verb === 'disarm') {
      if (!sentinel.arm(id, verb === 'arm')) {
        log(`No watch called "${id}".`, 'warn', 'watch');
        return Promise.resolve();
      }
      log(`${id} ${verb === 'arm' ? 'armed' : 'disarmed'}.`, 'ok', 'watch');
      return Promise.resolve();
    }

    if (verb === 'test') {
      const rule = sentinel.rules.get(id);
      if (!rule) {
        log(`No watch called "${id}".`, 'warn', 'watch');
        return Promise.resolve();
      }
      // Fire the real path, so what is exercised is what would happen.
      sentinel._raise(rule, 0, 0);
      return respond('Test alert raised.');
    }

    log('ACTIVE WATCHES', 'ok', 'watch');
    for (const rule of sentinel.list()) {
      const state = sentinel.state.get(rule.id);
      const status = !rule.armed ? 'DISARMED' : state?.active ? 'RAISED' : 'watching';
      log(
        `  ${mark(rule.signal)} ${rule.id.padEnd(16)} ${status.padEnd(9)} ${rule.label}`,
        state?.active ? rule.severity : 'sys',
        'watch',
      );
    }
    log('REAL = measured · PART = partly measured · SIM = invented', 'sys', 'watch');
    return respond(`${sentinel.list().filter((r) => r.armed).length} watches armed, sir.`);
  },
});

register({
  name: 'brief',
  aliases: ['digest', 'catchup'],
  summary: 'What happened while you were away.',
  run() {
    const events = sentinel.digest();
    if (!events.length) {
      log('Nothing raised this session.', 'ok', 'brief');
      return respond('Nothing to report, sir. All quiet.');
    }

    log(`${events.length} event${events.length === 1 ? '' : 's'} this session`, 'ok', 'brief');
    const now = Date.now();
    for (const event of events.slice(0, 12)) {
      log(
        `  ${duration((now - event.at) / 1000)} ago · ${event.title}${event.simulated ? ' (simulated)' : ''}`,
        event.level,
        'brief',
      );
      log(`       ${event.note}`, 'sys', 'brief');
    }

    const real = events.filter((e) => !e.simulated).length;
    return respond(
      real
        ? `${events.length} events, sir, ${real} of them from real signals.`
        : `${events.length} events, sir — all of them from simulated channels.`,
    );
  },
});
