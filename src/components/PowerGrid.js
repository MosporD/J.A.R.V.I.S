import { Component } from '../core/component.js';
import { store } from '../core/store.js';
import { telemetry } from '../core/telemetry.js';
import { clamp } from '../core/format.js';

/**
 * Power distribution.
 *
 * Each subsystem draws a share of whatever the arc reactor is currently
 * producing, so dropping the reactor with `reactor 30` visibly starves the
 * grid and pushes the lower-priority systems into brown-out. Priority decides
 * who keeps their allocation when there is not enough to go round.
 */
const SUBSYSTEMS = [
  { id: 'rep', label: 'REPULSORS', demand: 26, priority: 2 },
  { id: 'flt', label: 'FLIGHT STAB', demand: 18, priority: 2 },
  { id: 'lfs', label: 'LIFE SUPPORT', demand: 12, priority: 4 },
  { id: 'tgt', label: 'TARGETING', demand: 15, priority: 1 },
  { id: 'com', label: 'COMMS ARRAY', demand: 11, priority: 3 },
  { id: 'shd', label: 'SHIELDING', demand: 20, priority: 1 },
];

export class PowerGrid extends Component {
  render() {
    this.el.innerHTML = `
      <div class="space-y-1" data-grid>
        ${SUBSYSTEMS.map(
          (system) => `
          <div class="meter" data-system="${system.id}">
            <div class="flex items-baseline justify-between gap-2">
              <span class="flex items-center gap-1.5">
                <span class="led" data-tone="ok"></span>
                <span class="label-hud">${system.label}</span>
              </span>
              <span class="font-mono text-[0.6875rem] text-ink-dim tabular" data-draw>—</span>
            </div>
            <div class="meter-track mt-0.5"><div class="meter-fill" data-fill></div></div>
          </div>`,
        ).join('')}
      </div>
      <div class="mt-2 flex items-baseline justify-between border-t border-hud/10 pt-1.5">
        <span class="label-hud">TOTAL DRAW</span>
        <span class="font-mono text-xs text-hud text-glow-soft tabular" data-total>—</span>
      </div>
    `;

    this.rows = new Map(
      SUBSYSTEMS.map((system) => {
        const root = this.$(`[data-system="${system.id}"]`);
        return [system.id, {
          system,
          root,
          led: root.querySelector('.led'),
          draw: root.querySelector('[data-draw]'),
          fill: root.querySelector('[data-fill]'),
          current: system.demand,
        }];
      }),
    );
    this.total = this.$('[data-total]');

    this.on('telemetry', () => this.paint());
    this.paint();
  }

  paint() {
    const available = store.get('reactor');
    const demand = SUBSYSTEMS.reduce((sum, s) => sum + s.demand, 0);
    // Above 100% headroom nobody is starved; below it, low priority gives way.
    const headroom = clamp(available / (demand * 0.92), 0, 1.25);
    const jitter = telemetry.get('gpu')?.value ?? 40;

    let drawn = 0;
    for (const [, row] of this.rows) {
      const { system } = row;
      const share = clamp(
        headroom * (0.72 + system.priority * 0.09) + (jitter / 100 - 0.4) * 0.05,
        0,
        1.15,
      );
      const value = clamp(system.demand * share, 0, system.demand * 1.15);
      row.current += (value - row.current) * 0.35;
      drawn += row.current;

      const ratio = row.current / system.demand;
      const tone = ratio < 0.55 ? 'alert' : ratio < 0.82 ? 'warn' : 'ok';
      row.root.dataset.tone = tone;
      row.led.dataset.tone = tone;
      row.draw.textContent = `${row.current.toFixed(1)}%`;
      row.fill.style.width = `${clamp(ratio * 100, 0, 100)}%`;
    }

    this.total.textContent = `${drawn.toFixed(1)} / ${available}%`;
  }
}
