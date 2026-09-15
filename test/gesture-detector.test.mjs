import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GestureDetector, lumaFrom, GRID_W, GRID_H, SAMPLE_MS,
} from '../src/core/gesture-detector.js';

/** A brightness grid holding one bright blob, everything else dark. */
function frame({ x, y, r = 5, lit = true }) {
  const luma = new Uint8ClampedArray(GRID_W * GRID_H);
  if (!lit) return luma;
  for (let row = 0; row < GRID_H; row += 1) {
    for (let col = 0; col < GRID_W; col += 1) {
      if ((col - x) ** 2 + (row - y) ** 2 <= r * r) luma[row * GRID_W + col] = 255;
    }
  }
  return luma;
}

/** A filled band, for testing motion that covers a lot of frame at once. */
function band(lit) {
  const luma = new Uint8ClampedArray(GRID_W * GRID_H);
  if (lit) luma.fill(255, 0, Math.floor(luma.length * 0.45));
  return luma;
}

/**
 * Run frames through a detector and collect whatever it emits.
 * Every stroke is followed by still frames, since a stroke only ends once the
 * motion stops.
 */
function drive(frames, options = {}) {
  const detector = new GestureDetector({ mirror: false, ...options });
  const seen = [];
  let now = 1000;
  for (const luma of frames) {
    const gesture = detector.push(luma, now);
    if (gesture) seen.push({ gesture, now });
    now += SAMPLE_MS;
  }
  return { seen, detector };
}

/** A blob travelling from one grid point to another, then holding still. */
function sweep(from, to, steps = 8, settle = 4) {
  const frames = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    frames.push(frame({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }));
  }
  for (let i = 0; i < settle; i += 1) frames.push(frame(to));
  return frames;
}

test('a blob crossing to the right reads as a rightward swipe', () => {
  const { seen } = drive(sweep({ x: 6, y: 15 }, { x: 33, y: 15 }));
  assert.deepEqual(seen.map((s) => s.gesture), ['swipe-right']);
});

test('a blob crossing to the left reads as a leftward swipe', () => {
  const { seen } = drive(sweep({ x: 33, y: 15 }, { x: 6, y: 15 }));
  assert.deepEqual(seen.map((s) => s.gesture), ['swipe-left']);
});

test('mirroring flips left and right, so the operator sees their own hand', () => {
  const frames = sweep({ x: 6, y: 15 }, { x: 33, y: 15 });
  assert.equal(drive(frames, { mirror: false }).seen[0].gesture, 'swipe-right');
  assert.equal(drive(frames, { mirror: true }).seen[0].gesture, 'swipe-left');
});

test('a blob travelling down the frame reads as a downward swipe', () => {
  const { seen } = drive(sweep({ x: 20, y: 5 }, { x: 20, y: 25 }));
  assert.deepEqual(seen.map((s) => s.gesture), ['swipe-down']);
});

test('a blob travelling up the frame reads as an upward swipe', () => {
  const { seen } = drive(sweep({ x: 20, y: 25 }, { x: 20, y: 5 }));
  assert.deepEqual(seen.map((s) => s.gesture), ['swipe-up']);
});

test('a still frame is not a gesture', () => {
  const still = Array.from({ length: 12 }, () => frame({ x: 20, y: 15 }));
  assert.deepEqual(drive(still).seen, []);
});

test('an empty frame is not a gesture', () => {
  const dark = Array.from({ length: 12 }, () => frame({ x: 0, y: 0, lit: false }));
  assert.deepEqual(drive(dark).seen, []);
});

test('a small jitter is not a swipe', () => {
  const frames = [
    ...sweep({ x: 20, y: 15 }, { x: 22, y: 15 }, 3, 0),
    ...sweep({ x: 22, y: 15 }, { x: 20, y: 15 }, 3, 4),
  ];
  assert.deepEqual(drive(frames).seen.map((s) => s.gesture), []);
});

test('a large movement that stays put is a push', () => {
  const frames = [band(false), band(true), band(false), band(true),
    band(true), band(true), band(true)];
  assert.deepEqual(drive(frames).seen.map((s) => s.gesture), ['push']);
});

test('the first frame cannot be a gesture — there is nothing to compare it to', () => {
  const detector = new GestureDetector({ mirror: false });
  assert.equal(detector.push(frame({ x: 20, y: 15 }), 1000), null);
});

test('a frame of a different size restarts the comparison rather than throwing', () => {
  const detector = new GestureDetector({ mirror: false });
  detector.push(frame({ x: 10, y: 15 }), 1000);
  assert.equal(detector.push(new Uint8ClampedArray(10), 1050), null);
  assert.equal(detector.push(new Uint8ClampedArray(10), 1100), null);
});

test('a second swipe inside the cooldown is swallowed', () => {
  const frames = [
    ...sweep({ x: 6, y: 15 }, { x: 33, y: 15 }),
    ...sweep({ x: 6, y: 15 }, { x: 33, y: 15 }),
  ];
  // Two identical swipes back to back span far less than the cooldown.
  assert.deepEqual(drive(frames).seen.map((s) => s.gesture), ['swipe-right']);
});

test('an unbroken stroke is closed out rather than left open for ever', () => {
  const detector = new GestureDetector({ mirror: false });
  let now = 1000;
  let oldest = 0;
  // Motion on every single frame, for well past the maximum stroke length.
  for (let i = 0; i < 60; i += 1) {
    detector.push(frame({ x: 6 + (i % 2) * 20, y: 15 }), now);
    if (detector.stroke) oldest = Math.max(oldest, now - detector.stroke.startedAt);
    now += SAMPLE_MS;
  }
  assert.ok(oldest > 0, 'motion this large should have opened a stroke');
  assert.ok(oldest <= 1400 + SAMPLE_MS, `a stroke was left open for ${oldest}ms`);
});

test('flailing is not a gesture', () => {
  // Hand thrashing back and forth: plenty of motion, no net travel, and not
  // enough of the frame covered to be a push. It should resolve to nothing
  // rather than firing a directive because something moved.
  const frames = [];
  for (let i = 0; i < 60; i += 1) frames.push(frame({ x: 6 + (i % 2) * 20, y: 15 }));
  assert.deepEqual(drive(frames).seen.map((g) => g.gesture), []);
});

test('reset clears the stroke, the comparison frame and the cooldown', () => {
  const detector = new GestureDetector({ mirror: false });
  detector.push(frame({ x: 10, y: 15 }), 1000);
  detector.push(frame({ x: 20, y: 15 }), 1050);
  detector.reset();
  assert.equal(detector.previous, null);
  assert.equal(detector.stroke, null);
  assert.equal(detector.lastEmit, 0);
});

test('lumaFrom weights the channels and keeps one byte per pixel', () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  const luma = lumaFrom(rgba);
  assert.equal(luma.length, 2);
  assert.ok(luma[0] > 245, `white should be bright, got ${luma[0]}`);
  assert.equal(luma[1], 0);
});

test('green weighs more than blue, as human vision does', () => {
  const [green] = lumaFrom(new Uint8ClampedArray([0, 255, 0, 255]));
  const [blue] = lumaFrom(new Uint8ClampedArray([0, 0, 255, 255]));
  assert.ok(green > blue, `green ${green} should outweigh blue ${blue}`);
});
