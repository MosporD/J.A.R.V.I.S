import { Component } from '../core/component.js';
import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { audio } from '../core/audio.js';
import { telemetry } from '../core/telemetry.js';
import { clockTime, sigil } from '../core/format.js';

const MAX_ALERTS = 6;

/**
 * Anomaly register.
 *
 * Alerts arrive on the `alert` channel — from the telemetry threshold watcher,
 * from the `alert` command, or from any future panel. Each one is announced
 * once (cue + log line), listed with a severity tone, and ages out.
 */
export class AlertsPanel extends Component {
  render() {
    this.list = this.$('[data-alert-list]');
    this.watchlist = this.$('[data-watchlist]');
    this.entries = [];

    this.on('telemetry', () => this.paintWatchlist());

    this.watch('threat', (level) => {
      this.el.closest('.panel')?.setAttribute(
        'data-state',
        level === 'critical' ? 'alert' : 'nominal',
      );
    });

    this.on('alert', (alert) => this.add(alert));
    this.paint();
    this.paintWatchlist();
  }

  /**
   * What the register is watching, and how close each vector is to its limit.
   * An empty panel says nothing; this one says "nothing is wrong, and here is
   * how I know".
   */
  paintWatchlist() {
    if (!this.watchlist) return;
    const vectors = [
      ['THERMAL', telemetry.get('thm'), 74],
      ['COMPUTE', telemetry.get('cpu'), 88],
      ['MEMORY', telemetry.get('mem'), 90],
      ['ARC OUTPUT', telemetry.get('pwr'), 70, true],
    ];

    this.watchlist.innerHTML = vectors
      .map(([label, channel, limit, below]) => {
        if (!channel) return '';
        const margin = below
          ? ((channel.value - limit) / limit) * 100
          : ((limit - channel.value) / limit) * 100;
        const tone = margin < 8 ? 'alert' : margin < 22 ? 'warn' : 'ok';
        return `
          <div class="flex items-baseline justify-between gap-2 py-0.5">
            <span class="flex items-center gap-1.5">
              <span class="led" data-tone="${tone}"></span>
              <span class="label-hud">${label}</span>
            </span>
            <span class="font-mono text-[0.6875rem] text-ink-mute tabular">
              ${margin > 0 ? `${margin.toFixed(0)}% MARGIN` : 'BREACHED'}
            </span>
          </div>`;
      })
      .join('');
  }

  add({ level = 'warn', title = 'ANOMALY', note = '', source = 'sys' }) {
    this.entries.unshift({
      level,
      title,
      note,
      source,
      id: sigil(),
      at: clockTime(),
    });
    this.entries = this.entries.slice(0, MAX_ALERTS);

    if (level === 'alert') audio.alert();
    else audio.blip({ freq: 660, dur: 0.12, gain: 0.1, type: 'triangle' });

    bus.emit('log', { level, tag: source, text: `${title}${note ? ` — ${note}` : ''}` });
    bus.emit('core:pulse', { strength: level === 'alert' ? 1 : 0.5 });
    this.paint();
  }

  paint() {
    if (!this.entries.length) {
      this.list.innerHTML = `
        <li class="flex items-center gap-2 py-2">
          <span class="led" data-tone="ok"></span>
          <span class="font-mono text-[0.6875rem] text-ink-dim">No anomalies on record.</span>
        </li>`;
      return;
    }

    this.list.innerHTML = this.entries
      .map(
        (entry) => `
        <li class="animate-rise border-b border-hud/10 py-1.5 last:border-0">
          <div class="flex items-center justify-between gap-2">
            <span class="flex items-center gap-1.5 min-w-0">
              <span class="led" data-tone="${entry.level === 'alert' ? 'alert' : 'warn'}"></span>
              <span class="truncate font-mono text-[0.6875rem] ${
                entry.level === 'alert' ? 'text-alert text-glow-alert' : 'text-caution'
              }">${entry.title}</span>
            </span>
            <span class="label-hud shrink-0">${entry.at}</span>
          </div>
          ${entry.note ? `<div class="mt-0.5 pl-3.5 label-hud">${entry.note}</div>` : ''}
        </li>`,
      )
      .join('');
  }
}

/**
 * The threat read-out that sits in the core panel.
 *
 * It is deliberately its own component rather than a stray query from the
 * alerts panel: it lives in someone else's markup, and a component that
 * reaches outside its own subtree is a component that breaks silently when
 * the layout moves.
 */
export class ThreatBadge extends Component {
  render() {
    this.watch('threat', (level) => {
      this.el.textContent = level.toUpperCase();
      this.el.dataset.tone =
        level === 'critical' ? 'alert' : level === 'elevated' ? 'warn' : 'ok';
    });
  }
}
