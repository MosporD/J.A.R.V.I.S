import { Component } from '../core/component.js';

/**
 * The gesture toggle in the top rail.
 *
 * Same shape as the listen and narration toggles: the label carries the state
 * so the button is never lit without explanation, and `aria-pressed` carries
 * whether the camera is actually open. While it is open the label shows live
 * motion, which is the quickest way to tell a dead camera from a still room.
 */
export class GestureToggle extends Component {
  render() {
    this.watch('gesturing', (on) => {
      this.on = on;
      this.el.setAttribute('aria-pressed', String(Boolean(on)));
      this.paint();
    });
    this.watch('motion', (motion) => {
      this.motion = motion;
      if (this.on) this.paint();
    });
  }

  paint() {
    if (!this.on) {
      this.el.textContent = 'OPTICS OFF';
      return;
    }
    const bars = Math.min(4, Math.round((this.motion || 0) * 20));
    this.el.textContent = `OPTICS ${'▮'.repeat(bars).padEnd(4, '▯')}`;
  }
}
