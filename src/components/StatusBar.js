import { Component } from '../core/component.js';
import { store, MODE } from '../core/store.js';
import { audio } from '../core/audio.js';
import { speech } from '../core/speech.js';
import { telemetry } from '../core/telemetry.js';
import { clockTime, duration } from '../core/format.js';

const MODE_LABEL = {
  [MODE.IDLE]: 'STANDBY',
  [MODE.LISTENING]: 'LISTENING',
  [MODE.PROCESSING]: 'PROCESSING',
  [MODE.SPEAKING]: 'SPEAKING',
};

/**
 * The top rail: identity, current mode, connectivity, uptime and the two
 * hardware toggles (interface audio, voice synthesis).
 */
export class StatusBar extends Component {
  render() {
    this.mode = this.$('[data-mode]');
    this.modeLed = this.$('[data-mode-led]');
    this.clock = this.$('[data-clock]');
    this.uptime = this.$('[data-uptime]');
    this.link = this.$('[data-link]');
    this.fps = this.$('[data-fps]');

    this.watch('mode', (mode) => {
      this.mode.textContent = MODE_LABEL[mode] ?? 'STANDBY';
      this.modeLed.dataset.tone =
        mode === MODE.PROCESSING ? 'warn' : mode === MODE.IDLE ? 'idle' : 'ok';
    });

    this.watch('online', (online) => {
      this.link.textContent = online ? 'UPLINK OK' : 'UPLINK LOST';
      this.link.dataset.tone = online ? 'ok' : 'alert';
    });

    this.bindToggle('[data-toggle="sfx"]', 'sfx', (next) => audio.setEnabled(next));
    this.bindToggle('[data-toggle="voice"]', 'voice', (next) => {
      store.set('voice', next);
      if (!next) speech.cancel();
    });

    const tick = () => {
      this.clock.textContent = clockTime();
      this.uptime.textContent = duration(store.uptime());
      if (this.fps) this.fps.textContent = `${telemetry.fps} FPS`;
    };
    tick();
    const interval = setInterval(tick, 1000);
    this.track(() => clearInterval(interval));
  }

  /** Wire a toggle button to a boolean store key, keeping ARIA in step. */
  bindToggle(selector, key, apply) {
    const button = this.$(selector);
    if (!button) return;
    this.watch(key, (value) => button.setAttribute('aria-pressed', String(Boolean(value))));
    this.listen(button, 'click', () => apply(!store.get(key)));
  }
}
