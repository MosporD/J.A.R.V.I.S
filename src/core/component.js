import { bus } from './bus.js';
import { store } from './store.js';
import { ticker } from './ticker.js';

/**
 * Base class for every panel.
 *
 * Its only real job is teardown: listeners, bus subscriptions, store watchers,
 * ticker callbacks and observers all register through the instance, so
 * `destroy()` unwinds a panel completely without each component reinventing
 * bookkeeping.
 */
export class Component {
  /**
   * @param {string|Element} root  selector or element to mount into
   * @param {object} [options]
   */
  constructor(root, options = {}) {
    this.el = typeof root === 'string' ? document.querySelector(root) : root;
    this.options = options;
    this.disposers = [];
    this.mounted = false;
  }

  /** Subclasses override. Called once, only when the root element exists. */
  render() {}

  mount() {
    if (!this.el || this.mounted) return this;
    this.mounted = true;
    this.render();
    return this;
  }

  destroy() {
    this.disposers.forEach((dispose) => dispose());
    this.disposers.length = 0;
    this.mounted = false;
  }

  /** Track any teardown function. */
  track(dispose) {
    if (typeof dispose === 'function') this.disposers.push(dispose);
    return dispose;
  }

  /** addEventListener with automatic removal on destroy. */
  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    return this.track(() => target.removeEventListener(type, handler, options));
  }

  /** Subscribe to a bus channel. */
  on(channel, handler) {
    return this.track(bus.on(channel, handler));
  }

  /** Watch a store key. */
  watch(key, handler, eager = true) {
    return this.track(store.watch(key, handler, eager));
  }

  /** Join the shared render loop. */
  animate(fn) {
    return this.track(ticker.add(fn));
  }

  /** Scoped query inside this component's subtree. */
  $(selector) {
    return this.el.querySelector(selector);
  }

  $$(selector) {
    return [...this.el.querySelectorAll(selector)];
  }
}

/**
 * Canvas panel base — handles device-pixel-ratio scaling and resize so the
 * renderers can work in plain CSS pixels and stay crisp on any display.
 */
export class CanvasComponent extends Component {
  mount() {
    if (!this.el || this.mounted) return this;
    this.mounted = true;

    this.canvas = this.el.tagName === 'CANVAS' ? this.el : this.$('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.width = 0;
    this.height = 0;

    const observer = new ResizeObserver(() => this.resize());
    observer.observe(this.canvas.parentElement || this.canvas);
    this.track(() => observer.disconnect());

    this.resize();
    this.render();
    return this;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const box = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));
    if (w === this.width && h === this.height && this._dpr === dpr) return;

    this.width = w;
    this.height = h;
    this._dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.onResize?.(w, h);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }
}

/**
 * A single piece of text bound to the store.
 *
 * Read-outs that live in another panel's markup — the state and output figures
 * framing the reactor, for instance — get one of these instead of being queried
 * for from across the DOM. A component that reaches outside its own subtree
 * silently stops working the moment the layout moves, and nothing tells you.
 *
 *   new Readout('#core-value', {
 *     keys: ['reactor'],
 *     text: (s) => `${s.get('reactor')}%`,
 *   })
 */
export class Readout extends Component {
  render() {
    const { keys = [], text } = this.options;
    const paint = () => {
      this.el.textContent = text(store);
    };
    keys.forEach((key) => this.watch(key, paint, false));
    paint();
  }
}
