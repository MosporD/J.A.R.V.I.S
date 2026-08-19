import { CanvasComponent } from '../core/component.js';
import { store, MODE } from '../core/store.js';
import { bus } from '../core/bus.js';
import { palette, alpha } from '../core/theme.js';
import { telemetry } from '../core/telemetry.js';
import { prefersReducedMotion } from '../core/ticker.js';
import { approach, clamp } from '../core/format.js';

const TAU = Math.PI * 2;

/**
 * What the core is doing, in one word. A critical threat outranks the mode:
 * whatever J.A.R.V.I.S. is busy with matters less than the fact that
 * something is wrong.
 */
export function coreStateLabel(mode, threat) {
  if (threat === 'critical') return 'CRITICAL';
  switch (mode) {
    case MODE.LISTENING: return 'LISTENING';
    case MODE.PROCESSING: return 'PROCESSING';
    case MODE.SPEAKING: return 'SPEAKING';
    default: return 'STANDBY';
  }
}

/**
 * The reactor core — the interface's status made visible.
 *
 * Everything on this canvas is derived from live state: the ring speeds and
 * bloom follow the mode, two of the arcs are the real CPU and memory traces,
 * and the centre swells with the speech amplitude envelope. Nothing here is
 * decorative-only, which is what keeps it reading as an instrument.
 *
 * Glow is drawn as a wide translucent stroke beneath a thin bright one rather
 * than with `shadowBlur`, which is an order of magnitude cheaper per frame.
 */
export class ArcCore extends CanvasComponent {
  render() {
    this.spin = 0;
    this.counterSpin = 0;
    this.pulse = 0;          // 0..1 bloom, driven by amplitude + events
    this.energy = 0.4;       // eased "activity" level
    this.ripples = [];
    this.mode = MODE.IDLE;
    this.reduced = prefersReducedMotion;

    this.watch('mode', (mode) => {
      this.mode = mode;
      this.ripples.push({ r: 0.22, life: 1 });
    });

    this.on('core:pulse', ({ strength = 1 }) => {
      this.pulse = Math.min(1, this.pulse + strength * 0.6);
      this.ripples.push({ r: 0.18, life: 1 });
    });

    this.listen(this.canvas, 'pointerdown', () => {
      bus.emit('core:pulse', { strength: 1 });
    });

    this.animate((dt, elapsed) => this.frame(dt, elapsed));
  }

  /** Colour and rotation rate for the current state. */
  get scheme() {
    if (store.get('threat') === 'critical') return { key: palette.alert, speed: 2.4 };
    switch (this.mode) {
      case MODE.LISTENING:
        return { key: palette.hud, speed: 1.1 };
      case MODE.PROCESSING:
        return { key: palette.arc, speed: 3.1 };
      case MODE.SPEAKING:
        return { key: palette.hud, speed: 1.6 };
      default:
        return { key: palette.hud, speed: 0.55 };
    }
  }

  frame(dt, elapsed) {
    const { scheme } = this;
    const amplitude = store.get('amplitude');
    const targetEnergy = clamp(
      0.32 + amplitude * 0.85 + (this.mode === MODE.PROCESSING ? 0.35 : 0),
      0,
      1.4,
    );

    this.energy = approach(this.energy, targetEnergy, dt, 8);
    this.pulse = approach(this.pulse, amplitude * 0.7, dt, 4);

    const rate = this.reduced ? 0.15 : 1;
    this.spin += dt * scheme.speed * 0.32 * rate;
    this.counterSpin -= dt * scheme.speed * 0.19 * rate;

    for (const ripple of this.ripples) {
      ripple.r += dt * 0.55;
      ripple.life -= dt * 1.15;
    }
    this.ripples = this.ripples.filter((r) => r.life > 0).slice(-6);

    this.draw(elapsed, scheme, amplitude);
  }

  draw(t, scheme, amplitude) {
    const { ctx, width: w, height: h } = this;
    if (!w || !h) return;

    this.clear();
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 6;
    const key = scheme.key;

    ctx.save();
    ctx.translate(cx, cy);

    this.drawAmbient(R, key);
    this.drawTickRing(R * 1.0, key);
    this.drawSegments(R * 0.92, key);
    this.drawDashedRing(R * 0.85, key);
    this.drawBrackets(R * 0.79, key);

    const cpu = telemetry.get('cpu')?.value ?? 40;
    const mem = telemetry.get('mem')?.value ?? 55;
    this.drawDataArc(R * 0.7, cpu / 100, key, -Math.PI * 0.75, Math.PI * 1.1);
    this.drawDataArc(R * 0.62, mem / 100, palette.arc, Math.PI * 0.35, Math.PI * 1.1);

    this.drawOrbiters(R * 0.85, t, key);
    this.drawRipples(R, key);
    this.drawCore(R * 0.42, key, amplitude, t);

    ctx.restore();
  }

  /** Soft radial bloom behind everything. */
  drawAmbient(R, key) {
    const { ctx } = this;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.15);
    glow.addColorStop(0, alpha(key, 0.16 + this.energy * 0.16));
    glow.addColorStop(0.45, alpha(key, 0.05));
    glow.addColorStop(1, alpha(key, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.15, 0, TAU);
    ctx.fill();
  }

  /** Calibrated tick ring — 120 minor, every 10th major. */
  drawTickRing(radius, key) {
    const { ctx } = this;
    const count = 120;
    ctx.save();
    ctx.rotate(this.spin * 0.25);
    ctx.lineCap = 'butt';
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * TAU;
      const major = i % 10 === 0;
      const len = major ? 9 : 4;
      ctx.beginPath();
      ctx.strokeStyle = alpha(key, major ? 0.6 : 0.22);
      ctx.lineWidth = major ? 1.4 : 1;
      ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      ctx.lineTo(Math.cos(angle) * (radius - len), Math.sin(angle) * (radius - len));
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Four rotating arc segments of unequal length — the signature motion. */
  drawSegments(radius, key) {
    const { ctx } = this;
    const arcs = [
      [0.0, 0.42],
      [0.5, 0.16],
      [0.7, 0.1],
      [0.86, 0.08],
    ];
    ctx.save();
    ctx.rotate(this.spin);
    ctx.lineCap = 'round';
    for (const [start, length] of arcs) {
      const a0 = start * TAU;
      const a1 = (start + length) * TAU;
      // Wide soft pass = the glow.
      ctx.beginPath();
      ctx.strokeStyle = alpha(key, 0.12 + this.energy * 0.08);
      ctx.lineWidth = 7;
      ctx.arc(0, 0, radius, a0, a1);
      ctx.stroke();
      // Thin bright pass = the line.
      ctx.beginPath();
      ctx.strokeStyle = alpha(key, 0.85);
      ctx.lineWidth = 1.6;
      ctx.arc(0, 0, radius, a0, a1);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawDashedRing(radius, key) {
    const { ctx } = this;
    ctx.save();
    ctx.rotate(this.counterSpin);
    ctx.setLineDash([2, 9]);
    ctx.beginPath();
    ctx.strokeStyle = alpha(key, 0.42);
    ctx.lineWidth = 1;
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Four corner brackets that hold their angle against the spin. */
  drawBrackets(radius, key) {
    const { ctx } = this;
    ctx.save();
    ctx.rotate(this.counterSpin * 0.6 + Math.PI / 4);
    ctx.strokeStyle = alpha(key, 0.55);
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'square';
    for (let i = 0; i < 4; i += 1) {
      const base = (i / 4) * TAU;
      ctx.beginPath();
      ctx.arc(0, 0, radius, base - 0.09, base + 0.09);
      ctx.stroke();
      // Radial ticks at each end of the bracket.
      for (const end of [base - 0.09, base + 0.09]) {
        ctx.beginPath();
        ctx.moveTo(Math.cos(end) * radius, Math.sin(end) * radius);
        ctx.lineTo(Math.cos(end) * (radius + 6), Math.sin(end) * (radius + 6));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** A live metric rendered as a partially-filled arc on a track. */
  drawDataArc(radius, ratio, color, start, span) {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.strokeStyle = alpha(color, 0.12);
    ctx.lineWidth = 3;
    ctx.arc(0, 0, radius, start, start + span);
    ctx.stroke();

    const end = start + span * clamp(ratio, 0, 1);
    ctx.beginPath();
    ctx.strokeStyle = alpha(color, 0.18);
    ctx.lineWidth = 8;
    ctx.arc(0, 0, radius, start, end);
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = alpha(color, 0.95);
    ctx.lineWidth = 2.4;
    ctx.arc(0, 0, radius, start, end);
    ctx.stroke();

    // Leading marker.
    ctx.beginPath();
    ctx.fillStyle = alpha(color, 1);
    ctx.arc(Math.cos(end) * radius, Math.sin(end) * radius, 2.4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Three nodes on inclined orbits, with a short trailing tail. */
  drawOrbiters(radius, t, key) {
    const { ctx } = this;
    for (let i = 0; i < 3; i += 1) {
      const speed = 0.35 + i * 0.18;
      const angle = t * speed + (i * TAU) / 3;
      const squash = 0.42 + i * 0.2;

      ctx.save();
      ctx.rotate((i * Math.PI) / 3 + this.counterSpin * 0.3);
      for (let tail = 5; tail >= 0; tail -= 1) {
        const a = angle - tail * 0.05;
        const x = Math.cos(a) * radius;
        const y = Math.sin(a) * radius * squash;
        ctx.beginPath();
        ctx.fillStyle = alpha(key, (1 - tail / 6) * 0.7);
        ctx.arc(x, y, 2.6 - tail * 0.32, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawRipples(R, key) {
    const { ctx } = this;
    for (const ripple of this.ripples) {
      ctx.beginPath();
      ctx.strokeStyle = alpha(key, ripple.life * 0.45);
      ctx.lineWidth = 1.5;
      ctx.arc(0, 0, R * ripple.r, 0, TAU);
      ctx.stroke();
    }
  }

  /** The centre: layered discs, a triangular reactor motif, and the bloom. */
  drawCore(radius, key, amplitude, t) {
    const { ctx } = this;
    const swell = 1 + this.pulse * 0.16 + Math.sin(t * 1.6) * 0.012;
    const r = radius * swell;

    const bloom = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.6);
    bloom.addColorStop(0, alpha('#ffffff', 0.55 + amplitude * 0.35));
    bloom.addColorStop(0.28, alpha(key, 0.7));
    bloom.addColorStop(0.6, alpha(key, 0.14));
    bloom.addColorStop(1, alpha(key, 0));
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.6, 0, TAU);
    ctx.fill();

    // Containment rings.
    for (const [scale, width, a] of [[1, 1.8, 0.85], [0.72, 1.2, 0.5], [0.45, 1, 0.35]]) {
      ctx.beginPath();
      ctx.strokeStyle = alpha('#eaffff', a);
      ctx.lineWidth = width;
      ctx.arc(0, 0, r * scale, 0, TAU);
      ctx.stroke();
    }

    // The reactor triangle, slowly counter-rotating.
    ctx.save();
    ctx.rotate(-this.spin * 0.7);
    ctx.beginPath();
    for (let i = 0; i < 3; i += 1) {
      const a = (i / 3) * TAU - Math.PI / 2;
      const x = Math.cos(a) * r * 0.58;
      const y = Math.sin(a) * r * 0.58;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = alpha('#ffffff', 0.75);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = alpha(key, 0.25 + amplitude * 0.3);
    ctx.fill();
    ctx.restore();

    // Hot centre.
    ctx.beginPath();
    ctx.fillStyle = alpha('#ffffff', 0.85);
    ctx.arc(0, 0, r * 0.16 * (1 + amplitude * 0.5), 0, TAU);
    ctx.fill();
  }
}
