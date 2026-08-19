import { Component } from '../core/component.js';
import { telemetry } from '../core/telemetry.js';
import { palette, toneColor } from '../core/theme.js';
import { fitCanvas, drawGrid, drawTrace } from '../core/canvas.js';
import { bytes } from '../core/format.js';

/**
 * System diagnostics.
 *
 * A stacked CPU/memory area chart plus one instrument row per channel. Rows
 * are generated from the telemetry registry, so adding a channel in
 * core/telemetry.js makes it appear here with no markup change.
 */

const ROWS = ['cpu', 'mem', 'gpu', 'net', 'thm'];

/** Threshold -> severity. One rule, applied consistently across the panel. */
function toneFor(id, value) {
  if (id === 'net') return 'ok';
  if (id === 'thm') return value > 74 ? 'alert' : value > 62 ? 'warn' : 'ok';
  return value > 88 ? 'alert' : value > 72 ? 'warn' : 'ok';
}

export class Diagnostics extends Component {
  render() {
    this.el.innerHTML = `
      <div class="relative min-h-20 flex-1 sm:min-h-24">
        <canvas data-chart class="absolute inset-0 h-full w-full"></canvas>
        <div class="pointer-events-none absolute left-2 top-1.5 flex gap-3">
          <span class="label-hud" style="color: var(--color-hud)">■ CPU</span>
          <span class="label-hud" style="color: var(--color-arc)">■ MEM</span>
        </div>
        <div class="pointer-events-none absolute right-2 top-1.5 label-hud" data-peak>—</div>
      </div>
      <div class="mt-3 space-y-2" data-rows></div>
      <dl class="mt-3 grid grid-cols-2 gap-x-4 border-t border-hud/10 pt-1.5" data-hw></dl>
    `;

    this.chart = this.$('[data-chart]');
    this.chartCtx = this.chart.getContext('2d');
    this.peak = this.$('[data-peak]');
    this.rows = new Map();

    const host = this.$('[data-rows]');
    for (const id of ROWS) {
      const channel = telemetry.get(id);
      if (!channel) continue;

      const row = document.createElement('div');
      row.className = 'meter group';
      row.dataset.metric = id;
      row.innerHTML = `
        <div class="flex items-baseline justify-between gap-2">
          <span class="label-hud">${channel.label}</span>
          <span class="font-mono text-[0.6875rem] text-ink tabular" data-value>—</span>
        </div>
        <div class="mt-1 flex items-center gap-2">
          <div class="meter-track flex-1"><div class="meter-fill" data-fill></div></div>
          <canvas data-spark class="h-4 w-14 shrink-0"></canvas>
        </div>
      `;
      host.append(row);
      this.rows.set(id, {
        channel,
        root: row,
        value: row.querySelector('[data-value]'),
        fill: row.querySelector('[data-fill]'),
        spark: row.querySelector('[data-spark]'),
        sparkCtx: row.querySelector('[data-spark]').getContext('2d'),
      });
    }

    this.renderHardware();

    // Charts redraw on the sampler tick (4 Hz), not every animation frame —
    // the data only changes that fast, so anything more is wasted work.
    this.on('telemetry', () => this.paint());
    this.paint();
  }

  /**
   * Hardware facts and heap occupancy, paired two to a row. Where the browser
   * exposes the real figure it is shown; where it does not, the panel says so
   * rather than inventing one.
   */
  renderHardware() {
    const { cores, memoryGB, effectiveType } = telemetry.hardware;
    const heap = telemetry.heap;
    const cells = [
      ['CORES', String(cores)],
      ['ALLOCATED', heap ? bytes(heap.used) : 'N/D'],
      ['DEVICE MEM', memoryGB ? `${memoryGB} GB` : 'N/D'],
      ['CEILING', heap ? bytes(heap.limit) : 'N/D'],
      ['LINK', (effectiveType || 'DIRECT').toUpperCase()],
      ['RENDER', `${telemetry.fps} FPS`],
    ];

    // Only present where the Battery Status API is implemented.
    if (telemetry.battery) {
      const { level, charging } = telemetry.battery;
      cells.push(['POWER CELL', `${Math.round(level * 100)}%`]);
      cells.push(['SUPPLY', charging ? 'CHARGING' : 'INTERNAL']);
    }
    this.$('[data-hw]').innerHTML = cells
      .map(
        ([label, value]) => `
        <div class="flex items-baseline justify-between gap-2 py-0.5">
          <dt class="label-hud">${label}</dt>
          <dd class="font-mono text-[0.6875rem] text-ink-dim tabular">${value}</dd>
        </div>`,
      )
      .join('');
  }

  paint() {
    this.paintChart();
    this.renderHardware();
    for (const [id, row] of this.rows) this.paintRow(id, row);
  }

  paintChart() {
    const cpu = telemetry.get('cpu');
    const mem = telemetry.get('mem');
    if (!cpu || !mem) return;

    const { ctx, w, h } = fitCanvas(this.chart, this.chartCtx);
    drawGrid(ctx, w, h, palette.hud, { rows: 4, cols: 8 });

    drawTrace(ctx, mem.history.toArray(), {
      w, h, color: palette.arc, max: 100, lineWidth: 1.2,
    });
    drawTrace(ctx, cpu.history.toArray(), {
      w, h, color: palette.hud, max: 100, lineWidth: 1.6, baseline: cpu.history.mean,
    });

    if (this.peak) {
      this.peak.textContent = `PEAK ${cpu.history.max.toFixed(0)}% · FPS ${telemetry.fps}`;
    }
  }

  paintRow(id, row) {
    const { channel, value, fill, spark, sparkCtx, root } = row;
    const current = channel.value;
    const tone = toneFor(id, id === 'net' ? current : current);
    const ratio = Math.min(1, current / (channel.max || 100));

    root.dataset.tone = tone;
    value.textContent =
      id === 'net'
        ? `${current.toFixed(0)} ${channel.unit}`
        : `${current.toFixed(1)}${channel.unit}`;
    fill.style.width = `${ratio * 100}%`;

    const { ctx, w, h } = fitCanvas(spark, sparkCtx);
    drawTrace(ctx, channel.history.toArray(), {
      w,
      h,
      color: toneColor(tone),
      max: channel.max || 100,
      lineWidth: 1,
      fill: true,
      head: false,
    });
  }
}
