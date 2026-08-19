import { Component } from '../core/component.js';
import { store } from '../core/store.js';
import { palette, alpha } from '../core/theme.js';
import { fitCanvas } from '../core/canvas.js';
import { clockTime, stardate, hourIn } from '../core/format.js';
import { log, respond } from '../core/commands.js';

/**
 * World clock and location tracker.
 *
 * The clock is real — every zone is rendered through Intl, including the
 * day/night state used to dim sleeping cities. The radar beneath it is a
 * position display: contacts are seeded deterministically so they hold still
 * between frames, and the operator's own fix is plotted at the centre once
 * `locate` has run.
 */

const CITIES = [
  { name: 'MALIBU', zone: 'America/Los_Angeles', code: 'HQ' },
  { name: 'NEW YORK', zone: 'America/New_York', code: 'NYC' },
  { name: 'LONDON', zone: 'Europe/London', code: 'LDN' },
  { name: 'DUBAI', zone: 'Asia/Dubai', code: 'DXB' },
  { name: 'TOKYO', zone: 'Asia/Tokyo', code: 'TYO' },
];

export class WorldClock extends Component {
  render() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    this.el.innerHTML = `
      <div class="flex items-end justify-between gap-3">
        <div>
          <div class="font-display text-3xl leading-none text-hud text-glow tabular" data-local>--:--:--</div>
          <div class="label-hud mt-1" data-date>—</div>
        </div>
        <div class="text-right">
          <div class="label-hud">Zone</div>
          <div class="font-mono text-[0.6875rem] text-ink-dim">${zone.replace('_', ' ')}</div>
        </div>
      </div>

      <div class="relative mx-auto mt-3 aspect-square w-[min(100%,14rem)]">
        <canvas data-radar class="absolute inset-0 h-full w-full"></canvas>
        <div class="pointer-events-none absolute inset-x-0 bottom-1 text-center label-hud" data-fix>
          GRID REF · UNFIXED
        </div>
      </div>

      <ul class="mt-3 space-y-1" data-cities>
        ${CITIES.map(
          (city) => `
          <li class="flex items-baseline justify-between gap-2" data-city="${city.zone}">
            <span class="flex items-center gap-1.5">
              <span class="led" data-tone="idle" data-daylight></span>
              <span class="label-hud">${city.name}</span>
            </span>
            <span class="font-mono text-[0.6875rem] text-ink-dim tabular" data-time>--:--:--</span>
          </li>`,
        ).join('')}
      </ul>
    `;

    this.local = this.$('[data-local]');
    this.date = this.$('[data-date]');
    this.fix = this.$('[data-fix]');
    this.radar = this.$('[data-radar]');
    this.radarCtx = this.radar.getContext('2d');
    this.sweep = 0;
    this.contacts = this.seedContacts(7);

    this.watch('coordinates', (coords) => {
      this.fix.textContent = coords ? `GRID REF · ${coords.label}` : 'GRID REF · UNFIXED';
      this.fix.style.color = coords ? 'var(--color-hud)' : '';
    });

    // `time <city>` is answered here, where the zone table lives.
    this.on('clock:query', ({ query }) => this.answer(query));

    // Text updates once a second; the radar animates on the shared loop.
    this.tickClock();
    const interval = setInterval(() => this.tickClock(), 1000);
    this.track(() => clearInterval(interval));

    this.animate((dt) => this.paintRadar(dt));
  }

  /** Fixed pseudo-random contacts so blips do not jitter between frames. */
  seedContacts(count) {
    return Array.from({ length: count }, (_, i) => ({
      angle: (i * 2.39996) % (Math.PI * 2),
      radius: 0.24 + ((i * 37) % 70) / 100,
      drift: 0.02 + ((i * 13) % 9) / 220,
      id: `C-${String(i + 1).padStart(2, '0')}`,
      hostile: i === 4,
      lit: 0,
    }));
  }

  /** Resolve a city name from the tracked list and report its local time. */
  answer(query) {
    if (!query) return;
    const term = query.trim().toUpperCase();
    const city = CITIES.find(
      (c) => c.name.startsWith(term) || c.code === term || c.zone.toUpperCase().includes(term),
    );

    if (!city) {
      log(`No tracked location matches "${query}".`, 'warn', 'clock');
      respond(`I am not tracking a location called ${query}, sir.`);
      return;
    }

    const now = new Date();
    const time = clockTime(now, city.zone);
    const hour = hourIn(city.zone, now);
    const phase = hour >= 6 && hour < 19 ? 'daylight' : 'night';

    const row = this.$(`[data-city="${city.zone}"]`);
    row?.animate?.(
      [{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }],
      { duration: 700, iterations: 2 },
    );

    log(`${city.name} — ${time} (${phase})`, 'ok', 'clock');
    respond(`It is ${time.slice(0, 5)} in ${city.name.toLowerCase()}, currently ${phase}.`);
  }

  tickClock() {
    const now = new Date();
    this.local.textContent = clockTime(now);
    this.date.textContent = stardate(now);

    for (const city of CITIES) {
      const row = this.$(`[data-city="${city.zone}"]`);
      if (!row) continue;
      row.querySelector('[data-time]').textContent = clockTime(now, city.zone);
      const hour = hourIn(city.zone, now);
      const daylight = hour >= 6 && hour < 19;
      row.querySelector('[data-daylight]').dataset.tone = daylight ? 'ok' : 'idle';
      row.style.opacity = daylight ? '1' : '0.55';
    }
  }

  paintRadar(dt) {
    const { ctx, w, h } = fitCanvas(this.radar, this.radarCtx);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 10;
    const key = palette.hud;

    this.sweep = (this.sweep + dt * 0.85) % (Math.PI * 2);

    ctx.save();
    ctx.translate(cx, cy);

    // Range rings + graticule.
    ctx.strokeStyle = alpha(key, 0.18);
    ctx.lineWidth = 1;
    for (const scale of [0.33, 0.66, 1]) {
      ctx.beginPath();
      ctx.arc(0, 0, R * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let i = 0; i < 4; i += 1) {
      const a = (i / 4) * Math.PI;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * -R, Math.sin(a) * -R);
      ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
      ctx.stroke();
    }

    // Persistence trail. The conic gradient starts at the beam, so the last
    // stretch before it wraps back round is the arc the beam just left —
    // ramping that from transparent to bright gives a decaying phosphor trail.
    const trail = ctx.createConicGradient?.(this.sweep, 0, 0);
    if (trail) {
      trail.addColorStop(0, alpha(key, 0));
      trail.addColorStop(0.82, alpha(key, 0));
      trail.addColorStop(0.95, alpha(key, 0.1));
      trail.addColorStop(1, alpha(key, 0.34));
      ctx.fillStyle = trail;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fill();
    }

    // Leading edge of the sweep.
    ctx.strokeStyle = alpha(key, 0.7);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(this.sweep) * R, Math.sin(this.sweep) * R);
    ctx.stroke();

    // Contacts light up as the beam passes and fade behind it.
    for (const contact of this.contacts) {
      contact.angle += dt * contact.drift;
      const delta = Math.abs(((contact.angle - this.sweep + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (delta > Math.PI - 0.12) contact.lit = 1;
      contact.lit = Math.max(0, contact.lit - dt * 0.42);

      const x = Math.cos(contact.angle) * R * contact.radius;
      const y = Math.sin(contact.angle) * R * contact.radius;
      const tint = contact.hostile ? palette.alert : key;

      ctx.beginPath();
      ctx.fillStyle = alpha(tint, 0.18 * contact.lit);
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.fillStyle = alpha(tint, 0.25 + contact.lit * 0.75);
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Operator position.
    ctx.strokeStyle = alpha(key, 0.9);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.stroke();
    if (store.get('coordinates')) {
      ctx.beginPath();
      ctx.fillStyle = alpha(key, 0.9);
      ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
