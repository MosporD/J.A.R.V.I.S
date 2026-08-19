import { CanvasComponent } from '../core/component.js';
import { store, MODE } from '../core/store.js';
import { audio } from '../core/audio.js';
import { palette, alpha } from '../core/theme.js';
import { approach, clamp } from '../core/format.js';

const BARS = 56;

/**
 * Audio waveform visualiser.
 *
 * Two sources feed it, and it always takes the louder:
 *   1. the real analyser — live for interface cues and, if the operator grants
 *      it, the microphone;
 *   2. the speech amplitude envelope, because the Web Speech API's output is
 *      not routable into an analyser.
 *
 * Bars are mirrored around the centre line with peak caps that fall under
 * gravity, and an oscilloscope trace is laid over the top.
 */
export class Waveform extends CanvasComponent {
  render() {
    this.levels = new Float32Array(BARS);
    this.peaks = new Float32Array(BARS);
    this.trace = new Float32Array(BARS);
    // The read-out sits in the panel header, outside this component's root, so
    // it is injected by the caller instead of being hunted for across the DOM.
    this.label = this.options.label
      ? document.querySelector(this.options.label)
      : null;

    this.animate((dt, t) => this.frame(dt, t));
  }

  /** Live spectrum if audio is actually sounding, otherwise a modelled one. */
  sample(t) {
    const spectrum = audio.spectrum();
    const envelope = store.get('amplitude');
    const mode = store.get('mode');

    // Real analyser data — only trusted when something is genuinely audible.
    let real = null;
    if (spectrum) {
      let sum = 0;
      for (let i = 0; i < 64; i += 1) sum += spectrum[i];
      if (sum / 64 > 6) real = spectrum;
    }

    // A silent channel still has to look alive, so an ambient standing wave
    // runs underneath everything and the loudest source always wins.
    const ambientPeak =
      mode === MODE.LISTENING ? 0.42 : mode === MODE.PROCESSING ? 0.5 : 0.26;

    for (let i = 0; i < BARS; i += 1) {
      let value = 0;

      if (real) {
        // Log-ish bin mapping so low frequencies do not dominate the display.
        const bin = Math.floor(((i / BARS) ** 1.7) * (real.length * 0.62)) + 1;
        value = real[bin] / 255;
      } else if (envelope > 0.02) {
        // Formant-ish shape: a broad hump that narrows with amplitude.
        const centre = (i / (BARS - 1)) * 2 - 1;
        const body = Math.exp(-(centre * centre) * 2.4);
        const flutter =
          0.5 + 0.5 * Math.sin(t * 9 + i * 0.55) * Math.sin(t * 3.7 + i * 0.19);
        value = envelope * body * (0.55 + flutter * 0.65);
      }

      // Two travelling sines at different rates — never quite repeats.
      const ambient =
        ambientPeak *
        (0.45 + 0.55 * Math.sin(t * 1.9 - i * 0.27)) *
        (0.6 + 0.4 * Math.sin(t * 0.63 + i * 0.11));

      this.levels[i] = clamp(Math.max(value, ambient), 0, 1);
    }
  }

  frame(dt, t) {
    this.sample(t);
    const { ctx, width: w, height: h } = this;
    if (!w || !h) return;

    this.clear();
    const mid = h / 2;
    const gap = 2;
    const barWidth = Math.max(1.5, w / BARS - gap);
    const key = store.get('threat') === 'critical' ? palette.alert : palette.hud;

    // Centre rule.
    ctx.strokeStyle = alpha(key, 0.16);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(w, mid + 0.5);
    ctx.stroke();

    let loudest = 0;
    for (let i = 0; i < BARS; i += 1) {
      const level = this.levels[i];
      loudest = Math.max(loudest, level);

      // Peak caps rise instantly, fall under gravity.
      this.peaks[i] = level > this.peaks[i]
        ? level
        : Math.max(level, this.peaks[i] - dt * 0.55);
      this.trace[i] = approach(this.trace[i], level, dt, 14);

      const x = i * (barWidth + gap) + gap / 2;
      const half = Math.max(1, this.trace[i] * (mid - 8));

      const gradient = ctx.createLinearGradient(0, mid - half, 0, mid + half);
      gradient.addColorStop(0, alpha(key, 0.95));
      gradient.addColorStop(0.5, alpha(palette.arc, 0.55));
      gradient.addColorStop(1, alpha(key, 0.95));
      ctx.fillStyle = gradient;
      ctx.fillRect(x, mid - half, barWidth, half * 2);

      // Cap.
      const capY = mid - this.peaks[i] * (mid - 8);
      ctx.fillStyle = alpha(key, 0.85);
      ctx.fillRect(x, capY - 1, barWidth, 1.5);
      ctx.fillRect(x, mid + (mid - capY) - 0.5, barWidth, 1.5);
    }

    this.drawScope(ctx, w, h, mid, key, t);

    if (this.label) {
      const mode = store.get('mode');
      this.label.textContent =
        mode === MODE.SPEAKING
          ? `VOX ${(loudest * 100).toFixed(0)}%`
          : mode === MODE.LISTENING
            ? `INPUT ${(loudest * 100).toFixed(0)}%`
            : 'SILENT';
    }
  }

  /** A thin continuous trace over the bars — the oscilloscope layer. */
  drawScope(ctx, w, h, mid, key, t) {
    ctx.save();
    ctx.strokeStyle = alpha('#eaffff', 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const i = clamp(Math.floor((x / w) * BARS), 0, BARS - 1);
      const wobble = Math.sin(x * 0.06 + t * 6) * this.trace[i] * 6;
      const y = mid - this.trace[i] * (mid - 10) * 0.55 + wobble;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }
}
