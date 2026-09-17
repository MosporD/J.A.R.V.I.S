import { Component } from '../core/component.js';
import { history } from '../core/history.js';
import { trackedMetrics } from '../core/track.js';
import { sentinel } from '../core/sentinel.js';

/**
 * The numbers you keep by hand, made visible.
 *
 * Until now `track` could record a value and the sentinel could watch it, but
 * nothing showed it — a console whose most personal data is invisible unless
 * you type a command has a broken loop in it.
 *
 * Each metric is a stat tile: label, current value, change against a named
 * period, and a sparkline. Not a chart per metric — the story of one tracked
 * number is "what is it now, and which way is it going", and that is a stat
 * tile's exact job.
 *
 * The delta is deliberately NOT coloured green-up / red-down. Up is good for
 * cash and bad for weight, and the dashboard does not get to guess which you
 * meant: direction is shown with an arrow, and colour is applied only once the
 * metric declares a goal via `track goal <name> up|down`.
 */

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // the sparkline's span
const DELTA_MS = 7 * 24 * 60 * 60 * 1000;     // the named comparison period
const DELTA_LABEL = '7d';
const SPARK_POINTS = 24;
const REFRESH_MS = 30_000;

/** 1,284 · 12.9K · 4.2M — a stat tile value, not a raw float. */
export function compact(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 10 ? 1 : 0);
}

/** Even a single reading should draw something, so a flat line is valid output. */
export function sparkPath(series, width, height, pad = 2) {
  if (!series.length) return '';
  const values = series.map((s) => s.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const usable = height - pad * 2;

  const step = series.length > 1 ? width / (series.length - 1) : 0;
  return series
    .map((sample, i) => {
      const x = series.length > 1 ? i * step : width / 2;
      const y = pad + (1 - (sample.value - min) / span) * usable;
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join('');
}

/** Thin to a fixed point count so a year of samples still draws in one pass. */
export function thin(series, points = SPARK_POINTS) {
  if (series.length <= points) return series;
  const stride = series.length / points;
  const out = [];
  for (let i = 0; i < points; i += 1) out.push(series[Math.floor(i * stride)]);
  out[out.length - 1] = series[series.length - 1];   // always keep the latest
  return out;
}

export class MetricsPanel extends Component {
  render() {
    this.body = this.$('[data-metrics-body]');
    this.count = this.$('[data-metrics-count]');
    this.cache = new Map();

    this.on('track:record', () => this.refresh());
    this.on('track:forget', () => this.refresh());
    this.on('sentinel:raise', () => this.paint());
    this.on('sentinel:clear', () => this.paint());

    // Hover reads a historical point. The current value is already on the tile,
    // so this enhances rather than gates — nothing is reachable only by hover.
    this.listen(this.body, 'pointermove', (event) => this.probe(event));
    this.listen(this.body, 'pointerleave', () => this.clearProbe());

    const timer = setInterval(() => this.refresh(), REFRESH_MS);
    this.track(() => clearInterval(timer));

    this.refresh();
  }

  async refresh() {
    const metrics = trackedMetrics();
    const since = Date.now() - WINDOW_MS;

    await Promise.all(
      metrics.map(async (metric) => {
        const series = await history.series(`track:${metric.id}`, { since });
        this.cache.set(metric.id, series);
      }),
    );
    for (const id of [...this.cache.keys()]) {
      if (!metrics.some((m) => m.id === id)) this.cache.delete(id);
    }
    this.paint(metrics);
  }

  /** Change against the named period, and which way the metric wants to go. */
  delta(metric, series) {
    const cutoff = Date.now() - DELTA_MS;
    const earlier = series.filter((s) => s.at <= cutoff);
    const baseline = earlier.length ? earlier[earlier.length - 1] : series[0];
    if (!baseline || baseline.value === metric.last) return null;

    const change = metric.last - baseline.value;
    const direction = change > 0 ? 'up' : 'down';
    // Neutral unless the operator has said which way is good.
    const tone = !metric.goal ? 'flat' : metric.goal === direction ? 'good' : 'bad';
    return { change, direction, tone };
  }

  paint(metrics = trackedMetrics()) {
    if (!this.body) return;

    if (this.count) this.count.textContent = `${metrics.length} / TRK`;

    if (!metrics.length) {
      this.body.innerHTML = `
        <p class="font-mono text-[0.6875rem] leading-relaxed text-ink-dim">
          Nothing tracked yet. Record a number and it becomes a watched signal:
          <span class="text-hud">track cash 12500 JOD</span>
        </p>`;
      return;
    }

    const raised = new Set(
      sentinel.list()
        .filter((rule) => sentinel.state.get(rule.id)?.active)
        .map((rule) => rule.signal),
    );

    this.body.innerHTML = metrics
      .map((metric) => this.tile(metric, raised.has(`track:${metric.id}`)))
      .join('');
  }

  tile(metric, alerting) {
    const series = thin(this.cache.get(metric.id) ?? []);
    const delta = this.delta(metric, this.cache.get(metric.id) ?? []);
    const path = sparkPath(series, 88, 22);
    const unit = metric.unit ? `<span class="text-ink-mute"> ${metric.unit}</span>` : '';

    const arrow = delta ? (delta.direction === 'up' ? '▲' : '▼') : '';
    const deltaText = delta
      ? `${arrow} ${compact(Math.abs(delta.change))} vs ${DELTA_LABEL}`
      : `— vs ${DELTA_LABEL}`;

    return `
      <div class="metric-tile" data-metric="${metric.id}" data-alerting="${alerting}">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="led" data-tone="${alerting ? 'alert' : 'ok'}"></span>
            <span class="label-hud truncate">${metric.label}</span>
          </div>
          <div class="mt-0.5 font-mono text-[0.95rem] leading-none text-ink tabular">
            ${compact(metric.last)}${unit}
          </div>
          <div class="mt-1 metric-delta" data-delta data-tone="${delta?.tone ?? 'flat'}">${deltaText}</div>
        </div>
        <svg class="metric-spark" viewBox="0 0 88 22" width="88" height="22"
             preserveAspectRatio="none" aria-hidden="true">
          <path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5"
                stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        </svg>
      </div>`;
  }

  /** Nearest-sample readout, with the whole tile as the hit area. */
  probe(event) {
    const tile = event.target.closest?.('[data-metric]');
    if (!tile) return this.clearProbe();

    const svg = tile.querySelector('.metric-spark');
    const series = thin(this.cache.get(tile.dataset.metric) ?? []);
    if (!svg || series.length < 2) return;

    const box = svg.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const sample = series[Math.round(ratio * (series.length - 1))];
    if (!sample) return;

    const when = new Date(sample.at);
    tile.title = `${compact(sample.value)} · ${when.toISOString().slice(0, 16).replace('T', ' ')}`;
    return undefined;
  }

  clearProbe() {
    this.$$('[data-metric]').forEach((tile) => tile.removeAttribute('title'));
  }
}
