import { Component } from '../core/component.js';

/**
 * The spoken-directive toggle in the top rail.
 *
 * Same shape as the narration toggle: the label carries the state so the
 * button never sits unlit and unexplained, and `aria-pressed` carries whether
 * the microphone is actually open. Clicking dispatches `listen toggle` through
 * the existing quick-action binding.
 */
export class ListenToggle extends Component {
  render() {
    this.watch('dictating', (on) => {
      this.el.textContent = on ? 'EAR LIVE' : 'EAR OFF';
      this.el.setAttribute('aria-pressed', String(Boolean(on)));
    });
  }
}
