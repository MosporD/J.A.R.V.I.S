import { bus } from './bus.js';
import { store, MODE } from './store.js';
import { audio } from './audio.js';
import { speech } from './speech.js';
import { execute, register, log, respond } from './commands.js';

/**
 * Spoken directives — the input half of the voice loop.
 *
 * `speech.js` is the output half; this is the ear. The Web Speech API does the
 * recognition, which means Chrome and Edge only: Firefox ships no
 * implementation and Safari's is partial. The panel says so rather than
 * silently doing nothing.
 *
 * Worth knowing before switching it on: Chrome's implementation is not local.
 * Audio is streamed to a Google speech service for transcription, exactly as it
 * is for a search-by-voice. That is announced in the log every time recognition
 * starts, because a dashboard on a corporate desk should not quietly open a
 * microphone to a third party.
 */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/** Recognition stops itself on silence; these govern bringing it back. */
const RESTART_DELAY = 400;
const MAX_CONSECUTIVE_FAILURES = 4;

/**
 * Spoken forms that are not the directive's name.
 *
 * Deliberately short. The command registry already handles the verbs; this
 * only bridges the phrases a person actually says out loud to them.
 */
const PHRASES = [
  [/^(run |full )?(a )?(diagnostics?|diagnostic sweep|system check)$/, 'diag'],
  [/^(system )?(status|sitrep|report)$/, 'status'],
  [/^(sweep|scan)( for contacts| the area)?$/, 'scan'],
  [/^(where am i|locate( me)?|find my position)$/, 'locate'],
  [/^(clear|purge)( the)? (log|stream|screen)$/, 'clear'],
  [/^(show |list )?(the )?(help|directives|commands)$/, 'help'],
  [/^(reboot|restart|reinitialise|reinitialize)$/, 'boot'],
  [/^(go |switch )?(to )?(full ?screen)$/, null],
  [/^stop listening$/, 'listen off'],
];

export class Dictation {
  constructor() {
    this.recognition = null;
    this.enabled = false;
    this.failures = 0;
    this.restartTimer = null;
  }

  get supported() {
    return Boolean(Recognition);
  }

  /** Normalise an utterance into something the command registry recognises. */
  normalise(transcript) {
    let text = String(transcript).trim().toLowerCase();
    text = text.replace(/[.!?]+$/, '');
    // "Jarvis, run diagnostics" — address the assistant, then the directive.
    text = text.replace(/^(hey |ok |okay )?jarvis[,\s]+/i, '').trim();
    if (!text) return '';
    for (const [pattern, directive] of PHRASES) {
      if (pattern.test(text)) return directive ?? text;
    }
    return text;
  }

  start() {
    if (!this.supported) {
      log('This browser has no speech recognition — Chrome or Edge is required.', 'warn', 'listen');
      return false;
    }
    if (this.enabled) return true;

    this.enabled = true;
    this.failures = 0;
    store.set('dictating', true);
    log(
      'Recognition active. Chrome streams microphone audio to a Google service to transcribe it.',
      'warn',
      'listen',
    );
    this._spin();
    return true;
  }

  stop({ quiet = false } = {}) {
    this.enabled = false;
    clearTimeout(this.restartTimer);
    store.set('dictating', false);
    if (store.get('mode') === MODE.LISTENING) store.set('mode', MODE.IDLE);
    try {
      this.recognition?.abort();
    } catch {
      /* already torn down */
    }
    this.recognition = null;
    if (!quiet) log('Recognition stopped.', 'sys', 'listen');
  }

  toggle() {
    if (this.enabled) {
      this.stop();
      return false;
    }
    return this.start();
  }

  /** Build a recognition session and wire it up. Called again on every restart. */
  _spin() {
    if (!this.enabled) return;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-GB';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      this.failures = 0;
      store.set('mode', MODE.LISTENING);
    };

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) this._heard(transcript, result[0]?.confidence ?? 0);
        else interim += transcript;
      }
      if (interim) bus.emit('dictation:interim', { text: interim.trim() });
    };

    recognition.onerror = (event) => {
      // Silence is not a failure, and abort is us.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      this.failures += 1;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        log('Microphone permission refused — recognition cannot start.', 'alert', 'listen');
        this.stop({ quiet: true });
        return;
      }
      log(`Recognition error — ${event.error}.`, 'warn', 'listen');
      if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
        log('Too many recognition failures; standing down.', 'alert', 'listen');
        this.stop({ quiet: true });
      }
    };

    // Continuous recognition still ends itself — on a pause, on a network blip.
    // Bring it back rather than going quietly deaf.
    recognition.onend = () => {
      if (!this.enabled) return;
      this.restartTimer = setTimeout(() => this._spin(), RESTART_DELAY);
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      log(`Could not start recognition — ${error.message}`, 'alert', 'listen');
      this.stop({ quiet: true });
    }
  }

  /** A completed utterance. */
  _heard(transcript, confidence) {
    const raw = String(transcript).trim();
    if (!raw) return;

    const line = this.normalise(raw);
    bus.emit('dictation:final', { raw, line, confidence });

    if (!line) return;

    // Never let J.A.R.V.I.S. hear its own voice and act on it. Say so, though:
    // an operator whose directive vanished mid-reply deserves to know why
    // rather than concluding the microphone is dead.
    if (speech.speaking) {
      log(`Ignored while speaking: “${raw}”`, 'sys', 'listen');
      return;
    }

    audio.blip({ freq: 1320, dur: 0.05, gain: 0.05, type: 'triangle' });
    log(`“${raw}”`, 'user', 'heard');
    execute(line);
  }
}

export const dictation = new Dictation();

register({
  name: 'listen',
  aliases: ['dictate', 'dictation'],
  summary: 'Spoken directives — on | off.',
  run(args) {
    const verb = (args[0] || '').toLowerCase();
    const wantOff = verb === 'off' || verb === 'stop' || (verb === 'toggle' && dictation.enabled);
    if (wantOff) {
      dictation.stop();
      return respond('No longer listening, sir.');
    }
    if (!dictation.supported) {
      // Logged as well as spoken: a spoken reply is typed out and can queue
      // behind a long line, and a refusal should not wait on an animation.
      log('No speech recognition in this browser — Chrome or Edge is required.', 'warn', 'listen');
      return respond('This browser cannot hear me, sir. Chrome or Edge is required.');
    }
    if (!dictation.start()) return Promise.resolve();
    return respond('Listening. Address me by name, or simply give the directive.');
  },
});
