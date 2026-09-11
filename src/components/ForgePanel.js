import { Component } from '../core/component.js';
import { forge } from '../core/forge.js';

/**
 * Content foundry.
 *
 * Reads the same /health and /pipeline the service exposes to its own tooling,
 * so the panel cannot drift from what the pipeline believes about itself.
 *
 * The buffer meter is the point of this panel. Stage counts are interesting;
 * buffer depth is the one figure that predicts whether posting stops next week,
 * so it gets the meter and everything else gets a row.
 */

/** Stages worth a row, in pipeline order. */
const STAGES = [
  ['draft', 'AWAITING REVIEW'],
  ['approved', 'APPROVED'],
  ['ready', 'RENDERED'],
  ['queued', 'SCHEDULED'],
  ['published', 'PUBLISHED'],
];

/** Days of runway the buffer meter reads as full. */
const BUFFER_TARGET = 14;
const BUFFER_THIN = 7;

function bufferTone(buffer) {
  if (buffer === null) return 'idle';
  if (buffer < 3) return 'alert';
  return buffer < BUFFER_THIN ? 'warn' : 'ok';
}

export class ForgePanel extends Component {
  render() {
    this.el.innerHTML = `
      <div class="meter" data-buffer-meter data-tone="idle">
        <div class="flex items-baseline justify-between gap-2">
          <span class="label-hud">BUFFER</span>
          <span class="font-mono text-[0.6875rem] text-ink tabular" data-buffer>N/D</span>
        </div>
        <div class="meter-track mt-1"><div class="meter-fill" data-buffer-fill></div></div>
      </div>

      <dl class="mt-3" data-stages></dl>

      <div class="mt-3 border-t border-hud/10 pt-1.5" data-footer></div>
    `;

    this.meter = this.$('[data-buffer-meter]');
    this.bufferValue = this.$('[data-buffer]');
    this.bufferFill = this.$('[data-buffer-fill]');
    this.stages = this.$('[data-stages]');
    this.footer = this.$('[data-footer]');

    // Repainting on the poll rather than the render loop: this data changes
    // every ten seconds at best, so a frame-rate repaint would be pure waste.
    this.on('forge', () => this.paint());
    this.paint();
  }

  paint() {
    this.paintBuffer();
    this.paintStages();
    this.paintFooter();
  }

  paintBuffer() {
    const buffer = forge.online ? forge.buffer : null;
    const tone = bufferTone(buffer);

    this.meter.dataset.tone = tone;
    this.bufferValue.textContent =
      buffer === null ? 'N/D' : `${buffer} CUT${buffer === 1 ? '' : 'S'}`;
    this.bufferFill.style.width =
      buffer === null ? '0%' : `${Math.min(1, buffer / BUFFER_TARGET) * 100}%`;
  }

  paintStages() {
    const variants = forge.online ? forge.counts('variants') : {};
    const failed = forge.online ? (variants.failed ?? 0) : 0;

    const rows = STAGES.map(([key, label]) => {
      const count = forge.online ? (variants[key] ?? 0) : null;
      return `
        <div class="data-row">
          <dt class="data-label">${label}</dt>
          <dd class="data-value">${count === null ? 'N/D' : count}</dd>
        </div>`;
    });

    // Only shown when there is something to act on — an always-visible zero
    // trains you to stop reading the row that matters.
    if (failed > 0) {
      rows.push(`
        <div class="data-row" data-tone="alert">
          <dt class="data-label" style="color: var(--color-alert)">FAILED</dt>
          <dd class="data-value" style="color: var(--color-alert)">${failed}</dd>
        </div>`);
    }

    this.stages.innerHTML = rows.join('');
  }

  paintFooter() {
    if (!forge.online) {
      this.footer.innerHTML = `
        <div class="label-hud">FOUNDRY OFFLINE</div>
        <div class="mt-1 font-mono text-nano leading-relaxed text-ink-mute">
          ${forge.endpoint}
        </div>`;
      return;
    }

    const database = (forge.health?.database || 'unknown').split(':')[0].toUpperCase();
    const cells = [
      ['SELF-HOSTED', forge.selfHosted ?? 'N/D'],
      ['DATABASE', database],
    ];

    this.footer.innerHTML = cells
      .map(
        ([label, value]) => `
        <div class="flex items-baseline justify-between gap-2 py-0.5">
          <span class="label-hud">${label}</span>
          <span class="font-mono text-[0.6875rem] text-ink-dim tabular">${value}</span>
        </div>`,
      )
      .join('');
  }
}

/**
 * The link indicator in the panel header.
 *
 * Lives in the panel's markup but outside its body, so it is injected the same
 * way the reactor's corner read-outs are rather than queried for across the DOM.
 */
export class ForgeLink extends Component {
  render() {
    const paint = () => {
      const online = forge.online;
      this.el.dataset.tone = online ? 'ok' : 'idle';
      this.el.textContent = online ? 'LINKED' : 'OFFLINE';
    };
    this.on('forge:link', paint);
    this.on('forge', paint);
    paint();
  }
}
