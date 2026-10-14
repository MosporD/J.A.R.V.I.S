import { bus } from './bus.js';
import { store } from './store.js';
import { readLocal, writeLocal } from './storage.js';

/**
 * Synthesised interface audio.
 *
 * Every cue is generated with oscillators and a short noise buffer, so the
 * dashboard ships no audio assets and makes no network requests to sound.
 * Everything routes through a master analyser, which means the waveform panel
 * reacts to real audio rather than a pretend envelope.
 *
 * Browsers refuse to start an AudioContext before a user gesture; the engine
 * stays dormant until the first interaction and then resumes itself.
 */

const STORAGE_KEY = 'jarvis.sfx';

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.analyser = null;
    this.micStream = null;
    this.enabled = readLocal(STORAGE_KEY) !== 'off';
    this._data = null;
    this._level = 0;
    store.set('sfx', this.enabled);
  }

  /** Create the graph on first use. Safe to call repeatedly. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;

    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;

    // A gentle low-pass keeps the cues from sounding brittle.
    this.tone = this.ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 7200;

    // Output analyser, in line with the speakers.
    this.analyser = this._makeAnalyser();
    this._data = new Uint8Array(this.analyser.fftSize);
    this._freq = new Uint8Array(this.analyser.frequencyBinCount);

    // Input analyser, deliberately a dead end. An AnalyserNode still measures
    // whatever is connected to it without being connected onward, and routing
    // the microphone into the output graph would put the speakers into a
    // feedback loop with the room.
    this.micAnalyser = this._makeAnalyser();
    this._micData = new Uint8Array(this.micAnalyser.fftSize);
    this._micFreq = new Uint8Array(this.micAnalyser.frequencyBinCount);

    this.master.connect(this.tone);
    this.tone.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.noise = this._noiseBuffer(1.2);
    return this.ctx;
  }

  _makeAnalyser() {
    const node = this.ctx.createAnalyser();
    node.fftSize = 1024;
    node.smoothingTimeConstant = 0.72;
    return node;
  }

  _noiseBuffer(seconds) {
    const length = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) channel[i] = Math.random() * 2 - 1;
    return buffer;
  }

  setEnabled(on) {
    this.enabled = on;
    writeLocal(STORAGE_KEY, on ? 'on' : 'off');
    store.set('sfx', on);
    if (on) {
      this.init();
      this.blip({ freq: 880, dur: 0.08, gain: 0.15 });
    }
  }

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /** A single enveloped oscillator — the building block for every cue. */
  blip({
    freq = 660,
    to = null,
    dur = 0.12,
    gain = 0.18,
    type = 'sine',
    delay = 0,
    attack = 0.008,
  } = {}) {
    if (!this.enabled) return;
    const ctx = this.init();
    if (!ctx) return;

    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(env);
    env.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Filtered noise burst — used for texture under the tonal cues. */
  hiss({ dur = 0.18, gain = 0.05, freq = 2400, q = 1.4, delay = 0 } = {}) {
    if (!this.enabled) return;
    const ctx = this.init();
    if (!ctx) return;

    const t0 = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(freq, t0);
    band.Q.value = q;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    source.connect(band);
    band.connect(env);
    env.connect(this.master);
    source.start(t0);
    source.stop(t0 + dur + 0.02);
  }

  // --- Named cues ---------------------------------------------------------

  hover() {
    this.blip({ freq: 1560, dur: 0.05, gain: 0.045, type: 'triangle' });
  }

  click() {
    this.blip({ freq: 940, to: 1420, dur: 0.09, gain: 0.14, type: 'square' });
    this.hiss({ dur: 0.07, gain: 0.03, freq: 3200 });
  }

  confirm() {
    this.blip({ freq: 720, dur: 0.1, gain: 0.12 });
    this.blip({ freq: 1080, dur: 0.16, gain: 0.1, delay: 0.07 });
  }

  error() {
    this.blip({ freq: 240, to: 110, dur: 0.28, gain: 0.16, type: 'sawtooth' });
    this.hiss({ dur: 0.22, gain: 0.05, freq: 700 });
  }

  alert() {
    for (let i = 0; i < 3; i += 1) {
      this.blip({ freq: 1180, dur: 0.09, gain: 0.13, type: 'square', delay: i * 0.16 });
    }
  }

  /** Rising power-up used by the boot sequence. */
  power() {
    this.blip({ freq: 90, to: 720, dur: 1.5, gain: 0.16, type: 'sawtooth', attack: 0.4 });
    this.blip({ freq: 180, to: 1440, dur: 1.7, gain: 0.07, type: 'sine', attack: 0.6 });
    this.hiss({ dur: 1.8, gain: 0.035, freq: 1200, q: 0.8 });
  }

  /** Sweep used when a scan or diagnostic runs. */
  sweep() {
    this.blip({ freq: 420, to: 2200, dur: 0.5, gain: 0.08, type: 'sine' });
    this.hiss({ dur: 0.5, gain: 0.03, freq: 1800 });
  }

  // --- Analysis -----------------------------------------------------------

  /** Whichever analyser is carrying signal: the microphone wins when live. */
  get source() {
    if (this.micStream && this.micAnalyser) {
      return { node: this.micAnalyser, time: this._micData, freq: this._micFreq };
    }
    if (this.analyser) {
      return { node: this.analyser, time: this._data, freq: this._freq };
    }
    return null;
  }

  /** Live RMS level, 0..1, from whatever is currently sounding. */
  level() {
    const source = this.source;
    if (!source) return 0;
    source.node.getByteTimeDomainData(source.time);
    let sum = 0;
    for (let i = 0; i < source.time.length; i += 1) {
      const v = (source.time[i] - 128) / 128;
      sum += v * v;
    }
    this._level = Math.sqrt(sum / source.time.length);
    return Math.min(1, this._level * 4);
  }

  /** Frequency bins for the bar visualiser. */
  spectrum() {
    const source = this.source;
    if (!source) return null;
    source.node.getByteFrequencyData(source.freq);
    return source.freq;
  }

  /** Opt-in microphone capture, so "listening" can be genuinely reactive. */
  async enableMic() {
    if (this.micStream) return true;
    const ctx = this.init();
    if (!ctx || !navigator.mediaDevices?.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micStream = stream;
      this.micSource = ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.micAnalyser);
      store.set('mic', true);
      bus.emit('log', { level: 'ok', tag: 'audio', text: 'Microphone input engaged.' });
      return true;
    } catch (error) {
      bus.emit('log', {
        level: 'warn',
        tag: 'audio',
        text: `Microphone unavailable — ${error.name}.`,
      });
      return false;
    }
  }

  disableMic() {
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
    this.micSource = null;
    store.set('mic', false);
  }
}

export const audio = new AudioEngine();

/**
 * Wire the audio cues to the interface once, globally.
 * Delegated listeners mean new panels get cues for free.
 */
export function bindInterfaceSounds(root = document) {
  const resume = () => audio.init();
  ['pointerdown', 'keydown'].forEach((type) =>
    root.addEventListener(type, resume, { once: true, passive: true }),
  );

  root.addEventListener('pointerover', (event) => {
    if (event.target.closest?.('[data-sfx="hover"], .btn-hud, .chip[data-interactive]')) {
      audio.hover();
    }
  });

  root.addEventListener('pointerdown', (event) => {
    if (event.target.closest?.('[data-sfx="click"], .btn-hud')) audio.click();
  });
}
