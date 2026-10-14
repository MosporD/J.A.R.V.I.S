import { bus } from './bus.js';
import { store } from './store.js';
import { speech } from './speech.js';
import { register, respond, log } from './commands.js';

/**
 * Reading the event stream aloud.
 *
 * Speaking every log line is the obvious version of this and it does not work.
 * Three things break it, and each is handled here rather than at the call site:
 *
 *   Bursts. `status` and `forge` print eight lines at once and the boot
 *   sequence prints more. `speech.speak` interrupts, so a burst would be heard
 *   as four fragments and one complete sentence — hence `enqueue`, which reads
 *   them in order and drops its own backlog when it falls too far behind.
 *
 *   Double speech. `respond()` already speaks J.A.R.V.I.S.'s replies *and*
 *   emits a log line for them, so narrating the `jarvis` level would say every
 *   answer twice. `user` lines are the operator's own typing.
 *
 *   Noise. Ambient chatter fires every half minute or so and most lines are
 *   routine. At `alerts` only anomalies interrupt the room, which is the level
 *   worth leaving on; `all` exists for when you want the full stream.
 */

const ORDER = ['off', 'alerts', 'all'];

/** Already spoken by `respond()`, or typed by the operator. */
const NEVER = new Set(['jarvis', 'user']);

/** Levels that count as worth interrupting the room for. */
const URGENT = new Set(['alert', 'warn']);

/** Narration is slightly quicker and flatter than dialogue — it is reportage. */
const VOICE = { rate: 1.08, pitch: 0.9 };

/**
 * Strip what reads badly aloud.
 *
 * Log lines are formatted for a terminal: rules of em-dashes, and columns held
 * apart by runs of spaces. Spoken verbatim a header becomes a long pause and a
 * padded row loses its shape entirely, so rules are dropped and anything left
 * without real words is skipped.
 */
export function forSpeech(text) {
  const clean = String(text)
    .replace(/[—–\-_=·]{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[a-z0-9]/i.test(clean) && clean.length >= 3 ? clean : '';
}

export function shouldNarrate(level, mode = store.get('narrate')) {
  if (mode === 'off' || NEVER.has(level)) return false;
  return mode === 'all' || URGENT.has(level);
}

class Narrator {
  constructor() {
    this.last = '';
  }

  start() {
    bus.on('log', ({ level = 'sys', text = '' }) => this.consider(level, text));

    // Turning the voice off should silence pending narration too, not let a
    // queue resume speaking the moment it comes back on.
    store.watch('voice', (on) => {
      if (!on) speech.cancel({ clearQueue: true });
    }, false);

    store.watch('narrate', (mode) => {
      if (mode === 'off') speech.cancel({ clearQueue: true });
    }, false);

    return this;
  }

  consider(level, text) {
    // The boot sequence prints a burst before the interface is even up; nobody
    // wants thirty seconds of start-up read to them.
    if (!store.get('booted')) return;
    if (!shouldNarrate(level)) return;

    const line = forSpeech(text);
    // Repeated identical lines — a failing poll, a stuck reading — say nothing
    // new the second time.
    if (!line || line === this.last) return;

    this.last = line;
    speech.enqueue(line, VOICE);
  }
}

export const narrator = new Narrator();

export function setNarration(mode) {
  if (!ORDER.includes(mode)) return false;
  store.set('narrate', mode);
  return true;
}

const DESCRIPTION = {
  off: 'Narration off.',
  alerts: 'Narrating anomalies only.',
  all: 'Narrating the full event stream.',
};

register({
  name: 'narrate',
  aliases: ['narration'],
  summary: 'Read the event stream aloud — off | alerts | all.',
  run(args) {
    const current = store.get('narrate');
    const [requested] = args;

    // `cycle` is what the header button dispatches, so the button needs no
    // wiring of its own beyond the existing quick-action handler.
    if (requested === 'cycle') {
      const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
      setNarration(next);
      return respond(DESCRIPTION[next]);
    }

    if (!requested) {
      log(`Narration is ${current}. Options: ${ORDER.join(' | ')}.`, 'sys', 'narrate');
      return respond(DESCRIPTION[current]);
    }

    if (!setNarration(requested)) {
      log(`Unknown narration level "${requested}".`, 'warn', 'narrate');
      return respond(`I can narrate ${ORDER.join(', ')}, sir. Not "${requested}".`);
    }

    if (requested !== 'off' && !store.get('voice')) {
      log('Voice output is muted — narration will stay silent.', 'warn', 'narrate');
    }
    return respond(DESCRIPTION[requested]);
  },
});
