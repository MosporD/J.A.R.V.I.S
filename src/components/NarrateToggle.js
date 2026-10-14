import { Component } from '../core/component.js';
import { store } from '../core/store.js';

/**
 * The narration toggle in the top rail.
 *
 * A `Readout` would keep the label in step but cannot set `aria-pressed`, and
 * without it this button sits unlit between two lit ones and reads as disabled
 * rather than as off. Narration is tri-state, so the label carries the level
 * and the pressed style carries only whether it is speaking at all.
 *
 * Clicking is handled by the existing quick-action binding — the button
 * dispatches `narrate cycle` like any other directive button.
 */
export class NarrateToggle extends Component {
  render() {
    this.watch('narrate', (mode) => {
      this.el.textContent = `NARR ${String(mode).toUpperCase()}`;
      this.el.setAttribute('aria-pressed', String(mode !== 'off'));
    });
  }
}
