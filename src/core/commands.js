import { bus } from './bus.js';
import { store, MODE } from './store.js';
import { audio } from './audio.js';
import { speech } from './speech.js';
import { telemetry } from './telemetry.js';
import { refresh as refreshTokens } from './theme.js';
import { clamp, duration, dms, sigil, clockTime, bytes } from './format.js';

/**
 * The command layer.
 *
 * Commands are plain objects in a registry, so a new panel can contribute its
 * own verbs with `register()` without the prompt knowing anything about it.
 */

/** Split a line into tokens, honouring "quoted phrases". */
export function tokenize(line) {
  const out = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

const registry = new Map();

/**
 * What to try when no directive matches.
 *
 * The assistant registers itself here rather than being imported: the command
 * layer should not have to know a reasoning layer exists, and the assistant
 * needs this module's registry, so importing the other way would be a cycle.
 * Returns true when it handled the line.
 */
let fallback = null;

export function setFallback(handler) {
  fallback = handler;
  return () => { if (fallback === handler) fallback = null; };
}

export function register(command) {
  registry.set(command.name, command);
  (command.aliases || []).forEach((alias) =>
    registry.set(alias, { ...command, aliased: true }),
  );
  return command;
}

/** Unique commands, alphabetically — what `help` and tab-completion walk. */
export function catalogue() {
  return [...new Set(registry.values())]
    .filter((command) => !command.aliased)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function completions(prefix) {
  const term = prefix.toLowerCase();
  return [...registry.keys()].filter((name) => name.startsWith(term)).sort();
}

// --- Output helpers ---------------------------------------------------------

export const log = (text, level = 'sys', tag = 'sys') =>
  bus.emit('log', { level, tag, text });

/** J.A.R.V.I.S. answering: printed to the log and, when enabled, spoken. */
export function respond(text, { voice = true } = {}) {
  bus.emit('log', { level: 'jarvis', tag: 'jarvis', text, typed: true });
  if (voice) return speech.speak(text);
  return Promise.resolve();
}

const THEMES = {
  cyan: { hud: '#00f3ff', arc: '#0066ff' },
  arc: { hud: '#4da3ff', arc: '#0044cc' },
  amber: { hud: '#ffb000', arc: '#ff6a00' },
  crimson: { hud: '#ff4d5e', arc: '#b0002a' },
  viridian: { hud: '#2bffb5', arc: '#00a3ff' },
};

// --- The registry ------------------------------------------------------------

register({
  name: 'help',
  aliases: ['?', 'commands'],
  summary: 'List every available directive.',
  run() {
    log('AVAILABLE DIRECTIVES', 'ok', 'help');
    for (const command of catalogue()) {
      log(`  ${command.name.padEnd(10)} ${command.summary}`, 'sys', 'help');
    }
    return respond('Directive index displayed, sir.');
  },
});

register({
  name: 'status',
  aliases: ['sys', 'sitrep'],
  summary: 'Full systems report.',
  run() {
    const snap = telemetry.snapshot();
    log('— SYSTEMS REPORT ————————————————', 'ok', 'status');
    for (const { label, value, unit } of Object.values(snap)) {
      log(`  ${label.padEnd(14)} ${value.toFixed(1)}${unit}`, 'sys', 'status');
    }
    log(`  ${'FRAME RATE'.padEnd(14)} ${telemetry.fps} FPS`, 'sys', 'status');
    log(`  ${'UPTIME'.padEnd(14)} ${duration(store.uptime())}`, 'sys', 'status');
    log(`  ${'UPLINK'.padEnd(14)} ${store.get('online') ? 'ESTABLISHED' : 'SEVERED'}`,
      store.get('online') ? 'sys' : 'alert', 'status');
    if (telemetry.heap) {
      log(`  ${'HEAP'.padEnd(14)} ${bytes(telemetry.heap.used)}`, 'sys', 'status');
    }
    const threat = store.get('threat');
    return respond(
      threat === 'nominal'
        ? 'All systems nominal. Arc reactor holding steady.'
        : `Attention, sir. System state is ${threat}.`,
    );
  },
});

register({
  name: 'diag',
  aliases: ['diagnostics'],
  summary: 'Run a full diagnostic sweep.',
  async run() {
    audio.sweep();
    store.set('mode', MODE.PROCESSING);
    const stages = [
      'Interrogating power bus',
      'Verifying arc reactor containment',
      'Auditing memory sectors',
      'Testing uplink integrity',
      'Recalibrating sensor array',
    ];
    for (const stage of stages) {
      log(`${stage} …`, 'sys', 'diag');
      bus.emit('core:pulse', { strength: 0.5 });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 380));
    }
    const faults = Math.random() < 0.25 ? 1 : 0;
    log(
      faults ? `Sweep complete — ${faults} anomaly logged.` : 'Sweep complete — no faults.',
      faults ? 'warn' : 'ok',
      'diag',
    );
    if (faults) {
      bus.emit('alert', {
        level: 'warn',
        title: 'SENSOR DRIFT DETECTED',
        note: `Array ${sigil()} outside calibration tolerance`,
        source: 'diag',
      });
    }
    store.set('mode', MODE.IDLE);
    return respond(
      faults
        ? 'Diagnostic complete. One anomaly requires your attention.'
        : 'Diagnostic complete. Every subsystem is operating within tolerance.',
    );
  },
});

register({
  name: 'scan',
  summary: 'Sweep the local environment.',
  async run() {
    audio.sweep();
    store.set('mode', MODE.PROCESSING);
    bus.emit('scan:start');
    log('Initiating perimeter sweep …', 'sys', 'scan');
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const contacts = 2 + Math.floor(Math.random() * 5);
    log(`Sweep resolved — ${contacts} contacts within range.`, 'ok', 'scan');
    store.set('mode', MODE.IDLE);
    return respond(`Perimeter sweep complete. ${contacts} contacts, none hostile.`);
  },
});

register({
  name: 'clear',
  aliases: ['cls'],
  summary: 'Purge the log stream.',
  run() {
    bus.emit('log:clear');
    return Promise.resolve();
  },
});

register({
  name: 'say',
  aliases: ['speak'],
  summary: 'Speak a line aloud.',
  run(args) {
    const text = args.join(' ');
    if (!text) {
      log('Usage: say <text>', 'warn', 'say');
      return Promise.resolve();
    }
    return respond(text);
  },
});

register({
  name: 'sfx',
  aliases: ['mute', 'unmute'],
  summary: 'Interface audio cues — on | off.',
  run(args, { verb }) {
    let on;
    if (verb === 'mute') on = false;
    else if (verb === 'unmute') on = true;
    else if (args[0] === 'on') on = true;
    else if (args[0] === 'off') on = false;
    else on = !audio.enabled;

    audio.setEnabled(on);
    log(`Interface audio ${on ? 'engaged' : 'silenced'}.`, on ? 'ok' : 'warn', 'sfx');
    return Promise.resolve();
  },
});

register({
  name: 'voice',
  summary: 'Spoken responses — on | off.',
  run(args) {
    const on = args[0] === 'off' ? false : args[0] === 'on' ? true : !store.get('voice');
    store.set('voice', on);
    if (!on) speech.cancel();
    log(`Voice synthesis ${on ? 'enabled' : 'disabled'}.`, on ? 'ok' : 'warn', 'voice');
    return Promise.resolve();
  },
});

register({
  name: 'mic',
  summary: 'Microphone-reactive visualiser — on | off.',
  async run(args) {
    const wantOn = args[0] !== 'off';
    if (!wantOn) {
      audio.disableMic();
      store.set('mode', MODE.IDLE);
      log('Microphone released.', 'sys', 'mic');
      return;
    }
    const ok = await audio.enableMic();
    if (ok) {
      store.set('mode', MODE.LISTENING);
      await respond('I am listening, sir.');
    }
  },
});

register({
  name: 'locate',
  aliases: ['gps'],
  summary: 'Resolve current coordinates.',
  run() {
    if (!navigator.geolocation) {
      log('Geolocation hardware unavailable.', 'warn', 'gps');
      return respond('I have no positioning hardware to work with, sir.');
    }
    log('Triangulating …', 'sys', 'gps');
    store.set('mode', MODE.PROCESSING);

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          const label = `${dms(coords.latitude, 'N', 'S')} ${dms(coords.longitude, 'E', 'W')}`;
          store.set('coordinates', {
            lat: coords.latitude,
            lon: coords.longitude,
            accuracy: coords.accuracy,
            label,
          });
          log(`Position fixed — ${label} (±${Math.round(coords.accuracy)}m)`, 'ok', 'gps');
          store.set('mode', MODE.IDLE);
          resolve(respond('Position acquired and plotted.'));
        },
        (error) => {
          log(`Positioning failed — ${error.message}`, 'warn', 'gps');
          store.set('mode', MODE.IDLE);
          resolve(respond('I was unable to obtain a position fix.'));
        },
        { timeout: 10000, enableHighAccuracy: false },
      );
    });
  },
});

register({
  name: 'time',
  aliases: ['clock'],
  summary: 'Local time, or time in a tracked city.',
  run(args) {
    const query = args.join(' ');
    if (!query) {
      const now = clockTime();
      log(`Local time ${now}`, 'ok', 'clock');
      return respond(`It is ${now.slice(0, 5)} local time.`);
    }
    // The chronometer panel owns the zone table, so it answers this one.
    bus.emit('clock:query', { query });
    return Promise.resolve();
  },
});

register({
  name: 'reactor',
  aliases: ['power'],
  summary: 'Set arc reactor output, 0-100.',
  run(args) {
    const value = Number(args[0]);
    if (!Number.isFinite(value)) {
      log(`Arc output holding at ${store.get('reactor')}%.`, 'sys', 'reactor');
      return Promise.resolve();
    }
    const next = clamp(Math.round(value), 0, 100);
    telemetry.get('pwr').base = next;
    telemetry.get('pwr').target = next;
    store.set('reactor', next);
    bus.emit('core:pulse', { strength: 1 });
    audio.confirm();
    log(`Arc output set to ${next}%.`, next < 70 ? 'warn' : 'ok', 'reactor');
    return respond(
      next < 40
        ? 'That output will not sustain the primary systems for long, sir.'
        : `Arc reactor output set to ${next} percent.`,
    );
  },
});

register({
  name: 'alert',
  summary: 'Raise an alert — alert <warn|critical> <message>.',
  run(args) {
    const level = args[0] === 'critical' ? 'alert' : 'warn';
    const title = args.slice(1).join(' ').toUpperCase() || 'MANUAL ALERT RAISED';
    bus.emit('alert', { level, title, note: `Operator-issued · ${sigil()}`, source: 'manual' });
    return respond(level === 'alert' ? 'Critical alert logged, sir.' : 'Alert logged.');
  },
});

register({
  name: 'theme',
  summary: `Re-hue the interface — ${Object.keys(THEMES).join(' | ')} | next.`,
  run(args) {
    const names = Object.keys(THEMES);
    let name = (args[0] || '').toLowerCase();
    // `next` walks the list, so the palette can live on a single keystroke.
    if (name === 'next' || name === 'cycle') {
      const current = document.documentElement.style.getPropertyValue('--color-hud').trim();
      const index = names.findIndex((key) => THEMES[key].hud === current);
      name = names[(index + 1) % names.length];
    }
    const preset = THEMES[name];
    if (!preset) {
      log(`Available palettes: ${names.join(', ')}, next`, 'sys', 'theme');
      return Promise.resolve();
    }
    const root = document.documentElement;
    root.style.setProperty('--color-hud', preset.hud);
    root.style.setProperty('--color-arc', preset.arc);
    refreshTokens();
    audio.confirm();
    log(`Palette shifted to ${name.toUpperCase()}.`, 'ok', 'theme');
    return respond(`Interface re-hued to ${name}.`);
  },
});

register({
  name: 'boot',
  aliases: ['reboot', 'restart'],
  summary: 'Replay the start-up sequence.',
  run() {
    bus.emit('boot:replay');
    return Promise.resolve();
  },
});

/**
 * Hand a drafted message to whatever mail client the operator actually uses.
 *
 * The dashboard is a static front end with no server of its own, so it does not
 * send: it composes. A `mailto:` hand-off keeps the credentials where they
 * belong — in Outlook, or whatever is registered — and means there is nothing
 * here to leak, no key in the bundle and no account to configure.
 */

/** Deliberately permissive: reject the obviously malformed, not the unusual. */
const ADDRESS = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Most clients truncate a very long mailto; warn rather than silently lose it. */
const MAILTO_LIMIT = 1800;

export function parseEmail(rest) {
  const [to, ...tail] = rest;
  const recipients = (to || '').split(',').map((a) => a.trim()).filter(Boolean);
  const remainder = tail.join(' ');
  // `subject | body` — everything before the first pipe is the subject line.
  const pipe = remainder.indexOf('|');
  const subject = (pipe === -1 ? remainder : remainder.slice(0, pipe)).trim();
  const body = pipe === -1 ? '' : remainder.slice(pipe + 1).trim();
  return { recipients, subject, body };
}

export function mailtoURL({ recipients, subject, body }) {
  const query = [];
  if (subject) query.push(`subject=${encodeURIComponent(subject)}`);
  if (body) query.push(`body=${encodeURIComponent(body)}`);
  // Addresses are validated above, so they travel unencoded: some clients
  // mishandle a percent-encoded "@" in the recipient slot.
  return `mailto:${recipients.join(',')}${query.length ? `?${query.join('&')}` : ''}`;
}

/** Open the draft without navigating the dashboard away from itself. */
function openDraft(url) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}

register({
  name: 'email',
  aliases: ['mail', 'compose'],
  summary: 'Open a drafted message in your mail client.',
  run(args) {
    if (!args.length) {
      log('Usage: email <address[,address]> <subject> | <body>', 'warn', 'email');
      log('  e.g. email ops@zain.jo Reactor report | All systems nominal.', 'sys', 'email');
      return respond('Who am I writing to, sir?');
    }

    const draft = parseEmail(args);

    if (!draft.recipients.length) {
      audio.error();
      log('No recipient given.', 'alert', 'email');
      return respond('I need a recipient before I can draft that.');
    }

    const invalid = draft.recipients.filter((address) => !ADDRESS.test(address));
    if (invalid.length) {
      audio.error();
      log(`Not a usable address: ${invalid.join(', ')}`, 'alert', 'email');
      return respond('That address does not look right, sir.');
    }

    const url = mailtoURL(draft);
    if (url.length > MAILTO_LIMIT) {
      audio.error();
      log(
        `Draft is too long for a mail hand-off (${url.length} characters, limit ${MAILTO_LIMIT}).`,
        'alert',
        'email',
      );
      return respond('That message is too long to hand over. Shorten it and try again.');
    }

    try {
      openDraft(url);
    } catch (error) {
      audio.error();
      log(`Could not reach a mail client — ${error.message}`, 'alert', 'email');
      return respond('I could not raise a mail client on this machine.');
    }

    audio.confirm();
    log(`TO       ${draft.recipients.join(', ')}`, 'ok', 'email');
    log(`SUBJECT  ${draft.subject || '(none)'}`, 'sys', 'email');
    if (draft.body) log(`BODY     ${draft.body}`, 'sys', 'email');
    log('Draft handed to your mail client — review and send it there.', 'sys', 'email');

    return respond(
      `Draft prepared for ${draft.recipients.join(' and ')}. It is waiting in your mail client, sir.`,
    );
  },
});

register({
  name: 'uptime',
  summary: 'Time since the last cold start.',
  run() {
    const up = duration(store.uptime());
    log(`Online for ${up}.`, 'ok', 'uptime');
    return respond(`I have been online for ${up}.`);
  },
});

register({
  name: 'whoami',
  aliases: ['about', 'identify'],
  summary: 'Identify the operator and this system.',
  run() {
    log('OPERATOR ····· AUTHENTICATED', 'ok', 'auth');
    log(`SESSION ······ ${sigil()}-${sigil()}`, 'sys', 'auth');
    log('CLEARANCE ···· ALPHA', 'sys', 'auth');
    log('SYSTEM ······· J.A.R.V.I.S. // Just A Rather Very Intelligent System', 'sys', 'auth');
    return respond(
      'I am J.A.R.V.I.S. — Just A Rather Very Intelligent System. At your service, sir.',
    );
  },
});

// --- Conversational fallback -------------------------------------------------

const SMALL_TALK = [
  [/\b(hello|hi|hey|good (morning|evening|afternoon))\b/i,
    ['Good to see you again, sir.', 'Hello, sir. All systems are at your disposal.']],
  [/\bthank(s| you)\b/i, ['Always a pleasure, sir.', 'Think nothing of it.']],
  [/\bhow are you\b/i,
    ['Operating at peak efficiency, sir. Thank you for asking.',
     'All my subsystems report nominal. Yours, I am less certain about.']],
  [/\b(who|what) (are|r) you\b/i,
    ['I am J.A.R.V.I.S., your resident artificial intelligence.']],
  [/\bjoke\b/i,
    ['I would tell you a joke about the arc reactor, sir, but the delivery would be too energetic.']],
  [/\b(shut ?down|sleep|goodnight|bye)\b/i,
    ['Very good, sir. I shall be here when you need me.']],
];

function smallTalk(line) {
  for (const [pattern, replies] of SMALL_TALK) {
    if (pattern.test(line)) return replies[Math.floor(Math.random() * replies.length)];
  }
  return null;
}

const UNKNOWN = [
  'I am afraid that directive is not in my index, sir. Try "help".',
  'I did not recognise that instruction. "help" will list what I can do.',
  'That is outside my current directive set, sir.',
];

/**
 * Execute a submitted line. Always resolves — a failing command reports itself
 * rather than taking the prompt down with it.
 */
export async function execute(line) {
  const raw = String(line).trim();
  if (!raw) return;

  bus.emit('log', { level: 'user', tag: 'you', text: raw });

  const [verb, ...args] = tokenize(raw);
  const command = registry.get(verb.toLowerCase());

  if (command) {
    store.set('mode', MODE.PROCESSING);
    try {
      await command.run(args, { verb: verb.toLowerCase(), raw });
    } catch (error) {
      console.error('[command] failed', error);
      audio.error();
      log(`Directive failed — ${error.message}`, 'alert', 'error');
    } finally {
      if (store.get('mode') === MODE.PROCESSING) store.set('mode', MODE.IDLE);
    }
    return;
  }

  const reply = smallTalk(raw);
  if (reply) {
    store.set('mode', MODE.PROCESSING);
    await new Promise((resolve) => setTimeout(resolve, 260));
    await respond(reply);
    return;
  }

  // Nothing matched. Before giving up, offer it to the assistant — an
  // unrecognised line is usually a sentence, not a typo.
  if (fallback) {
    try {
      if (await fallback(raw)) return;
    } catch (error) {
      console.error('[command] fallback failed', error);
    }
  }

  audio.error();
  await respond(UNKNOWN[Math.floor(Math.random() * UNKNOWN.length)]);
}
