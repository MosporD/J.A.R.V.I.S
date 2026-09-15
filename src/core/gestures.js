import { bus } from './bus.js';
import { store } from './store.js';
import { execute, register, log, respond } from './commands.js';
import { GestureDetector, lumaFrom, GESTURE_BINDINGS, GRID_W, GRID_H, SAMPLE_MS } from './gesture-detector.js';

export { GESTURE_BINDINGS } from './gesture-detector.js';

/**
 * Gesture directives — waving at the dashboard.
 *
 * Deliberately not a hand-tracking model. A skeletal landmarker wants a
 * multi-megabyte model and a wasm runtime fetched from a CDN at start-up, and a
 * dashboard that stops responding to your hands because a corporate proxy
 * blocked a CDN is worse than one that never offered it. This reads motion
 * straight off the camera instead: downscale each frame, difference it against
 * the last, and watch where the moving pixels travel.
 *
 * The trade is honest. It cannot tell a thumbs-up from a peace sign — it knows
 * only that something moved, roughly where, and which way it went. What it buys
 * is that it works offline, adds nothing to the bundle, needs no third party,
 * and can be tested without a camera.
 *
 * Nothing leaves the machine. Frames are drawn to a 40x30 canvas, reduced to
 * brightness, and discarded; the only thing that outlives a frame is a centroid
 * and an energy figure. That is the opposite of the speech path, which streams
 * audio to a Google service, and the log says so when each is switched on.
 */

export class Gestures {
  constructor() {
    this.detector = new GestureDetector();
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.timer = null;
    this.enabled = false;
  }

  get supported() {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async start() {
    if (this.enabled) return true;
    if (!this.supported) {
      log('This browser exposes no camera — gesture directives unavailable.', 'warn', 'gesture');
      return false;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: 'user' },
        audio: false,
      });
    } catch (error) {
      // A refused permission is a decision, not a fault. Say which it was.
      const denied = error?.name === 'NotAllowedError';
      log(
        denied
          ? 'Camera access declined — gesture directives stay closed.'
          : `Camera unavailable — ${error?.message || error}`,
        denied ? 'sys' : 'warn',
        'gesture',
      );
      return false;
    }

    this.video = document.createElement('video');
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('aria-hidden', 'true');
    // Offscreen rather than `display: none`: a hidden video is allowed to stop
    // producing frames, and a stopped video is a dead gesture pipeline.
    this.video.style.cssText =
      'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:-10px;top:-10px';
    document.body.append(this.video);
    await this.video.play().catch(() => {});

    this.canvas = document.createElement('canvas');
    this.canvas.width = GRID_W;
    this.canvas.height = GRID_H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.detector.reset();
    this.enabled = true;
    store.set('gesturing', true);
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);

    log('Optical input open. Frames are read on this machine and discarded.', 'ok', 'gesture');
    return true;
  }

  sample() {
    if (!this.enabled || !this.video || this.video.readyState < 2) return;
    this.ctx.drawImage(this.video, 0, 0, GRID_W, GRID_H);
    const { data } = this.ctx.getImageData(0, 0, GRID_W, GRID_H);
    const gesture = this.detector.push(lumaFrom(data), performance.now());
    store.set('motion', Number(this.detector.energy.toFixed(3)));
    if (gesture) this.dispatch(gesture);
  }

  /** Run whatever a completed gesture is bound to. */
  dispatch(gesture) {
    const binding = GESTURE_BINDINGS[gesture];
    bus.emit('gesture', { gesture, binding });
    log(`Gesture — ${gesture}${binding ? ` → ${binding.label}` : ''}`, 'ok', 'gesture');
    if (!binding) return;
    if (binding.directive) execute(binding.directive);
    else bus.emit('core:pulse', { strength: 1 });
  }

  stop() {
    if (!this.enabled) return;
    this.enabled = false;
    clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video?.remove();
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.detector.reset();
    store.set({ gesturing: false, motion: 0 });
    log('Optical input closed.', 'sys', 'gesture');
  }

  toggle() {
    return this.enabled ? (this.stop(), false) : this.start();
  }
}

export const gestures = new Gestures();

register({
  name: 'gesture',
  aliases: ['gestures', 'optics'],
  summary: 'Gesture directives on or off (on | off | toggle).',
  async run(args = []) {
    // The registry hands a command its arguments already split into an array.
    const want = String(args[0] || '').toLowerCase();
    if (want === 'off') {
      gestures.stop();
      return respond('Optical input closed, sir.');
    }
    if (want === 'list') {
      log('GESTURE BINDINGS', 'ok', 'gesture');
      for (const [name, { label }] of Object.entries(GESTURE_BINDINGS)) {
        log(`  ${name.padEnd(12)} ${label}`, 'sys', 'gesture');
      }
      return respond('Gesture index displayed, sir.');
    }
    if (want === 'toggle' && gestures.enabled) {
      gestures.stop();
      return respond('Optical input closed, sir.');
    }
    const started = await gestures.start();
    return started
      ? respond('Optical input open. Sweep a hand across the camera, sir.')
      : Promise.resolve();
  },
});
