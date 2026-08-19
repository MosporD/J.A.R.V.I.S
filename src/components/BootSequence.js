import { Component } from '../core/component.js';
import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { audio } from '../core/audio.js';
import { respond } from '../core/commands.js';
import { prefersReducedMotion } from '../core/ticker.js';
import { sigil } from '../core/format.js';

/**
 * Cold-start sequence.
 *
 * Prints the power-on checklist, fills a progress bar, then hands the
 * interface over. Skippable with any key or click — a start-up animation that
 * cannot be dismissed is a start-up animation the operator resents. Under
 * `prefers-reduced-motion` it prints instantly and steps straight to ready.
 */
const LINES = [
  ['ARC REACTOR', 'containment stable'],
  ['POWER BUS', 'output nominal'],
  ['SENSOR ARRAY', 'calibrated'],
  ['MEMORY LATTICE', 'integrity verified'],
  ['UPLINK', 'handshake complete'],
  ['VOICE SYNTHESIS', 'online'],
  ['OPERATOR', 'authenticated'],
];

export class BootSequence extends Component {
  render() {
    this.lines = this.$('[data-boot-lines]');
    this.bar = this.$('[data-boot-bar]');
    this.pct = this.$('[data-boot-pct]');
    this.serial = this.$('[data-boot-serial]');
    this.running = false;

    if (this.serial) this.serial.textContent = `${sigil()}·${sigil()}`;

    const skip = (event) => {
      if (!this.running) return;
      if (event.type === 'keydown' && event.key === 'Tab') return;
      this.finish(true);
    };
    this.listen(window, 'keydown', skip);
    this.listen(this.el, 'pointerdown', skip);

    this.on('boot:replay', () => this.start());
    this.start();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.aborted = false;
    this.el.dataset.done = 'false';
    this.lines.replaceChildren();
    audio.power();

    const step = prefersReducedMotion ? 10 : 260;

    for (let i = 0; i < LINES.length; i += 1) {
      if (this.aborted) return;
      const [system, note] = LINES[i];
      this.print(system, note);
      this.progress(((i + 1) / LINES.length) * 100);
      audio.blip({ freq: 520 + i * 90, dur: 0.06, gain: 0.07, type: 'triangle' });
      // eslint-disable-next-line no-await-in-loop
      await this.wait(step);
    }

    if (this.aborted) return;
    this.progress(100);
    await this.wait(prefersReducedMotion ? 10 : 420);
    this.finish(false);
  }

  print(system, note) {
    const row = document.createElement('div');
    row.className = 'flex items-baseline gap-2 animate-rise';
    row.innerHTML = `
      <span class="font-mono text-[0.6875rem] text-ink-mute">&gt;</span>
      <span class="font-mono text-[0.6875rem] text-hud text-glow-soft">${system}</span>
      <span class="flex-1 border-b border-dashed border-hud/20 translate-y-[-3px]"></span>
      <span class="font-mono text-[0.6875rem] text-ink-dim">${note}</span>
      <span class="font-mono text-[0.6875rem] text-hud">OK</span>
    `;
    this.lines.append(row);
  }

  progress(value) {
    if (this.bar) this.bar.style.width = `${value}%`;
    if (this.pct) this.pct.textContent = `${Math.round(value)}%`;
  }

  wait(ms) {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      this.track(() => clearTimeout(id));
    });
  }

  finish(skipped) {
    if (!this.running) return;
    this.running = false;
    this.aborted = true;
    this.progress(100);
    this.el.dataset.done = 'true';

    const first = !store.get('booted');
    store.set('booted', true);
    bus.emit('boot:done', { skipped });
    bus.emit('core:pulse', { strength: 1 });

    bus.emit('log', {
      level: 'ok',
      tag: 'boot',
      text: skipped ? 'Start-up sequence bypassed. All systems online.' : 'All systems online.',
    });

    // The greeting only happens once per session, and only after a gesture has
    // unlocked audio — otherwise the browser silently drops it.
    if (first) {
      setTimeout(() => {
        respond(
          'Good day, sir. All systems are online and the arc reactor is holding steady. How may I help?',
        );
      }, 600);
    }
  }
}
