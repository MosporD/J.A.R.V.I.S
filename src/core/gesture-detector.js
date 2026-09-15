/**
 * Gesture detection, with no camera anywhere near it.
 *
 * Kept free of the media stack on purpose. Everything here takes brightness
 * grids and returns gesture names, so the logic a hand exercises can be
 * exercised by a synthetic blob instead — in Node, in milliseconds, with no
 * webcam, no permission prompt and no browser. `gestures.js` is the thin glue
 * that points a camera at it.
 */

/** Sampling grid. Small on purpose: motion survives downscaling, noise does not. */
export const GRID_W = 40;
export const GRID_H = 30;

/** Sampling rate. Fast enough to catch a swipe, slow enough to cost nothing. */
export const SAMPLE_MS = 50;

/** A cell counts as moving when its brightness shifts by more than this (0-255). */
const PIXEL_THRESHOLD = 18;

/**
 * Thresholds for the stroke state machine.
 *
 * Start and end differ on purpose: a single threshold chatters, opening and
 * closing a stroke on the same wave as the figure crosses it.
 *
 * The numbers come from sweeping a disc of known size across the grid and
 * measuring, not from taste. Peak motion energy against the fraction of frame
 * the moving thing covers:
 *
 *     covers   2.4%   4.2%   6.5%   9.4%  12.8%  16.8%  26.2%
 *     energy  0.031  0.041  0.057  0.064  0.075  0.087  0.112
 *
 * A hand at arm's length in a 320x240 frame covers something like 10-25%, so
 * it arrives around 0.06-0.11. Starting at 0.035 also catches a hand held
 * further back, at about 3.5% of frame; below that it is too small to aim
 * with anyway, and the gate is doing more good keeping lighting flicker out.
 */
const START_ENERGY = 0.035;
const END_ENERGY = 0.018;

/** A stroke must travel this far across the frame to count as a swipe. */
const MIN_TRAVEL = 0.16;

/**
 * A stroke that stays put is a push only if it moved this much of the frame.
 *
 * A palm advancing on the camera grows from roughly a tenth of the frame to a
 * third, so the difference between frames runs around 0.2. Set above the
 * sweep figures in the table above — which top out near 0.11 — so travelling
 * motion is never mistaken for a push, and below what an advancing hand
 * actually produces.
 */
const PUSH_ENERGY = 0.22;

const MIN_SAMPLES = 3;
const MAX_STROKE_MS = 1400;
const QUIET_SAMPLES = 2;
const COOLDOWN_MS = 800;

/**
 * Motion strokes to directives.
 *
 * Chosen so the movement matches the meaning: raise a hand to raise a report,
 * sweep down to sweep the log away, push to poke the reactor.
 */
export const GESTURE_BINDINGS = {
  'swipe-up': { directive: 'status', label: 'Systems report' },
  'swipe-down': { directive: 'clear', label: 'Clear the log' },
  'swipe-left': { directive: 'scan', label: 'Sweep for contacts' },
  'swipe-right': { directive: 'diag', label: 'Diagnostic sweep' },
  push: { directive: null, label: 'Pulse the reactor' },
};

/**
 * The detection itself, with no camera anywhere near it.
 *
 * Takes brightness grids and returns gesture names. Keeping it free of the
 * media stack is what makes it testable: a synthetic blob swept across a few
 * dozen frames exercises exactly the code a hand does, in a headless browser
 * with no webcam attached.
 */
export class GestureDetector {
  constructor(options = {}) {
    this.width = options.width ?? GRID_W;
    this.height = options.height ?? GRID_H;
    this.mirror = options.mirror ?? true;
    this.reset();
  }

  reset() {
    this.previous = null;
    this.stroke = null;
    this.quiet = 0;
    this.lastEmit = 0;
    this.energy = 0;
  }

  /**
   * Feed one frame of brightness, 0-255, row-major.
   *
   * @returns {string|null} the gesture that just completed, if any.
   */
  push(luma, now) {
    const previous = this.previous;
    this.previous = luma.slice();
    if (!previous || previous.length !== luma.length) return null;

    let moving = 0;
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < luma.length; i += 1) {
      if (Math.abs(luma[i] - previous[i]) <= PIXEL_THRESHOLD) continue;
      moving += 1;
      sumX += i % this.width;
      sumY += Math.floor(i / this.width);
    }

    const energy = moving / luma.length;
    this.energy = energy;
    if (!moving) return this.step(null, energy, now);

    // Normalise to 0..1 and mirror, so a hand moving to the operator's right
    // reads as moving right rather than as the camera sees it.
    let x = sumX / moving / (this.width - 1);
    const y = sumY / moving / (this.height - 1);
    if (this.mirror) x = 1 - x;
    return this.step({ x, y }, energy, now);
  }

  /** Advance the stroke state machine by one sample. */
  step(centroid, energy, now) {
    if (!this.stroke) {
      if (centroid && energy >= START_ENERGY && now - this.lastEmit > COOLDOWN_MS) {
        this.stroke = {
          startedAt: now, from: centroid, to: centroid, peak: energy, samples: 1,
        };
      }
      return null;
    }

    if (centroid && energy >= END_ENERGY) {
      this.stroke.to = centroid;
      this.stroke.peak = Math.max(this.stroke.peak, energy);
      this.stroke.samples += 1;
      this.quiet = 0;
    } else {
      this.quiet += 1;
    }

    const stalled = this.quiet >= QUIET_SAMPLES;
    const overran = now - this.stroke.startedAt > MAX_STROKE_MS;
    if (!stalled && !overran) return null;

    const gesture = this.classify(this.stroke);
    this.stroke = null;
    this.quiet = 0;
    if (gesture) this.lastEmit = now;
    return gesture;
  }

  /** Decide what a finished stroke was. */
  classify(stroke) {
    if (stroke.samples < MIN_SAMPLES) return null;
    const dx = stroke.to.x - stroke.from.x;
    const dy = stroke.to.y - stroke.from.y;

    if (Math.max(Math.abs(dx), Math.abs(dy)) < MIN_TRAVEL) {
      return stroke.peak >= PUSH_ENERGY ? 'push' : null;
    }
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'swipe-right' : 'swipe-left';
    // Image rows run downward, so a positive dy is a downward sweep.
    return dy > 0 ? 'swipe-down' : 'swipe-up';
  }
}

/** Brightness of an RGBA buffer, as the detector wants it. */
export function lumaFrom(rgba) {
  const luma = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0; i < luma.length; i += 1) {
    const p = i * 4;
    // Rec. 601 weights, integer-ish — this runs 1200 times per sample.
    luma[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return luma;
}
