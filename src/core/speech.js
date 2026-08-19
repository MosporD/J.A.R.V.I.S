import { bus } from './bus.js';
import { store, MODE } from './store.js';
import { ticker } from './ticker.js';
import { clamp } from './format.js';

/**
 * Voice output.
 *
 * The Web Speech API gives no access to its audio graph, so its output cannot
 * be measured by an analyser. Instead this module runs a synthetic amplitude
 * envelope — a fast syllabic carrier under a slower phrase contour, nudged
 * upward by the utterance's word-boundary events — and that envelope is what
 * the waveform visualiser and the reactor core read.
 *
 * The envelope is deliberately independent of the synthesiser's success. A
 * machine with no installed voices ends (or errors) the utterance instantly,
 * and a muted interface never starts one; in both cases the envelope still
 * runs for the reading time estimated from the text, so the dashboard behaves
 * identically whether or not the operator can actually hear anything.
 */

const PREFERRED_VOICES = [
  /Daniel/i,        // macOS en-GB
  /Google UK English Male/i,
  /Arthur/i,
  /en-GB/i,
  /English \(United Kingdom\)/i,
];

class Speech {
  constructor() {
    this.synth = window.speechSynthesis || null;
    this.voice = null;
    this.envelope = 0;
    this.target = 0;
    this.speaking = false;
    this._floor = null;
    this._stopTicker = null;

    if (this.synth) {
      const pick = () => this.pickVoice();
      pick();
      this.synth.addEventListener?.('voiceschanged', pick);
    }
  }

  /** Choose the most J.A.R.V.I.S.-adjacent voice the platform offers. */
  pickVoice() {
    const voices = this.synth?.getVoices?.() ?? [];
    if (!voices.length) return;
    for (const pattern of PREFERRED_VOICES) {
      const match = voices.find((v) => pattern.test(v.name) || pattern.test(v.lang));
      if (match) {
        this.voice = match;
        return;
      }
    }
    this.voice = voices.find((v) => v.lang?.startsWith('en')) || voices[0];
  }

  get available() {
    return Boolean(this.synth);
  }

  /**
   * Speak a line. Always resolves.
   *
   * The visual envelope is driven by the *text*, not by the synthesiser: a
   * platform with no installed voices ends the utterance immediately (or
   * errors), and if the envelope followed that, the waveform and the reactor
   * would never move. So a floor timer runs for the estimated reading time,
   * and is only stood down once a boundary event proves a real voice is
   * carrying the line — at which point `onend` becomes the source of truth.
   */
  speak(text, { rate = 1.02, pitch = 0.92 } = {}) {
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (!clean) return Promise.resolve();

    this.cancel();
    this.beginEnvelope();
    store.set('mode', MODE.SPEAKING);
    bus.emit('speech:start', { text: clean });

    // ~13 characters per second is a natural reading pace.
    const estimate = clamp((clean.length / 13) * 1000, 700, 12000);
    const useVoice = Boolean(store.get('voice') && this.synth);
    this._simulate(estimate, useVoice);

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(this._floor);
        this._floor = null;
        this.speaking = false;
        this.target = 0;
        bus.emit('speech:end', { text: clean });
        if (store.get('mode') === MODE.SPEAKING) store.set('mode', MODE.IDLE);
        resolve();
      };

      this._floor = setTimeout(finish, estimate);

      if (!useVoice) return;

      const utterance = new SpeechSynthesisUtterance(clean);
      if (this.voice) utterance.voice = this.voice;
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = 1;

      utterance.onboundary = () => {
        // A real voice is speaking — hand timing over to the engine.
        clearTimeout(this._floor);
        this._floor = null;
        this.target = 0.55 + Math.random() * 0.45;
      };
      // Only authoritative once the floor has been stood down; otherwise an
      // instant end (no voices installed) would cut the envelope short.
      utterance.onend = () => {
        if (!this._floor) finish();
      };
      utterance.onerror = () => {
        if (!this._floor) finish();
      };

      // Some engines stall if a previous utterance is still pending.
      this.synth.cancel();
      this.synth.speak(utterance);
    });
  }

  /** Free-running mouth movement when boundary events are absent or muted. */
  _simulate(ms, gentle = false) {
    const start = performance.now();
    const tick = () => {
      if (!this.speaking) return;
      const t = performance.now() - start;
      if (t > ms) {
        if (!gentle) this.target = 0;
        return;
      }
      // Syllabic rhythm: a fast carrier under a slower phrase contour.
      const syllable = 0.5 + 0.5 * Math.sin(t / 90);
      const phrase = 0.6 + 0.4 * Math.sin(t / 640);
      const level = clamp(syllable * phrase * (gentle ? 0.75 : 1), 0.08, 1);
      this.target = Math.max(this.target * 0.6, level);
      setTimeout(tick, 55);
    };
    tick();
  }

  beginEnvelope() {
    this.speaking = true;
    if (this._stopTicker) return;
    this._stopTicker = ticker.add((dt) => {
      // Attack fast, release slow — the shape of a voice.
      const speed = this.target > this.envelope ? 22 : 7;
      this.envelope += (this.target - this.envelope) * (1 - Math.exp(-speed * dt));
      if (this.speaking) this.target *= 0.94;
      store.set('amplitude', Number(this.envelope.toFixed(3)));

      if (!this.speaking && this.envelope < 0.005) {
        this.envelope = 0;
        store.set('amplitude', 0);
        this._stopTicker?.();
        this._stopTicker = null;
      }
    });
  }

  cancel() {
    clearTimeout(this._floor);
    this._floor = null;
    this.synth?.cancel();
    this.speaking = false;
    this.target = 0;
    if (store.get('mode') === MODE.SPEAKING) store.set('mode', MODE.IDLE);
  }
}

export const speech = new Speech();
