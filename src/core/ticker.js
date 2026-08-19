/**
 * One requestAnimationFrame loop for the entire dashboard.
 *
 * Six canvases each running their own rAF is six wake-ups per frame and six
 * chances to drift out of phase. Everything animated registers here instead and
 * receives a shared, clamped delta plus the frame clock.
 *
 * The loop also measures real frame time, which the diagnostics panel reports
 * as genuine FPS rather than a simulated number.
 */
class Ticker {
  constructor() {
    this.subscribers = new Set();
    this.running = false;
    this.last = 0;
    this.elapsed = 0;
    this.fps = 60;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._frame = this._frame.bind(this);

    // Stop burning frames on a backgrounded tab.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else this.start();
    });
  }

  /**
   * @param {(dt: number, elapsed: number) => void} fn  dt is in seconds.
   * @returns {() => void} unsubscribe
   */
  add(fn) {
    this.subscribers.add(fn);
    this.start();
    return () => {
      this.subscribers.delete(fn);
      if (!this.subscribers.size) this.stop();
    };
  }

  start() {
    if (this.running || !this.subscribers.size) return;
    this.running = true;
    this.last = performance.now();
    this.handle = requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }

  _frame(now) {
    if (!this.running) return;

    // Clamp: a tab that was hidden for a minute must not produce a 60s delta.
    const dt = Math.min((now - this.last) / 1000, 1 / 20);
    this.last = now;
    this.elapsed += dt;

    this._fpsAccum += dt;
    this._fpsFrames += 1;
    if (this._fpsAccum >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAccum);
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    for (const fn of this.subscribers) {
      try {
        fn(dt, this.elapsed);
      } catch (error) {
        console.error('[ticker] subscriber failed', error);
        this.subscribers.delete(fn);
      }
    }

    this.handle = requestAnimationFrame(this._frame);
  }
}

export const ticker = new Ticker();

/** True when the operating system asks for reduced motion. */
export const prefersReducedMotion = window.matchMedia(
  '(prefers-reduced-motion: reduce)',
).matches;
