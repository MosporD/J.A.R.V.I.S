import { alpha } from './theme.js';

/**
 * Canvas plumbing shared by every renderer: DPR-correct sizing plus the two
 * chart primitives the dashboard reuses (area traces and grids).
 */

/**
 * Size a canvas to its CSS box at the display's pixel ratio.
 * @returns {{ctx: CanvasRenderingContext2D, w: number, h: number}}
 */
export function fitCanvas(canvas, ctx = canvas.getContext('2d')) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const box = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Faint measurement grid behind a trace. */
export function drawGrid(ctx, w, h, color, { rows = 4, cols = 8 } = {}) {
  ctx.save();
  ctx.strokeStyle = alpha(color, 0.08);
  ctx.lineWidth = 1;
  for (let i = 1; i < rows; i += 1) {
    const y = Math.round((h / rows) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  for (let i = 1; i < cols; i += 1) {
    const x = Math.round((w / cols) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * An area trace with a gradient fill, a bright stroke and a glowing head.
 *
 * @param {ArrayLike<number>} values oldest -> newest
 * @param {object} opts
 */
export function drawTrace(ctx, values, {
  w,
  h,
  color,
  max = 100,
  min = 0,
  fill = true,
  lineWidth = 1.4,
  head = true,
  smooth = true,
  baseline = null,
} = {}) {
  const n = values.length;
  if (!n) return;

  const span = Math.max(1e-6, max - min);
  const px = (i) => (i / (n - 1)) * w;
  const py = (v) => h - ((v - min) / span) * h;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(px(0), py(values[0]));

  for (let i = 1; i < n; i += 1) {
    if (smooth) {
      // Midpoint quadratic smoothing — no overshoot, no library.
      const x0 = px(i - 1);
      const y0 = py(values[i - 1]);
      const x1 = px(i);
      const y1 = py(values[i]);
      ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    } else {
      ctx.lineTo(px(i), py(values[i]));
    }
  }
  ctx.lineTo(px(n - 1), py(values[n - 1]));

  if (fill) {
    const area = new Path2D();
    // Rebuild the path closed to the floor for the gradient fill.
    area.moveTo(px(0), h);
    for (let i = 0; i < n; i += 1) area.lineTo(px(i), py(values[i]));
    area.lineTo(px(n - 1), h);
    area.closePath();

    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, alpha(color, 0.38));
    gradient.addColorStop(0.6, alpha(color, 0.1));
    gradient.addColorStop(1, alpha(color, 0));
    ctx.fillStyle = gradient;
    ctx.fill(area);
  }

  ctx.strokeStyle = alpha(color, 0.95);
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.stroke();

  if (baseline !== null) {
    ctx.beginPath();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = alpha(color, 0.35);
    ctx.lineWidth = 1;
    ctx.moveTo(0, py(baseline));
    ctx.lineTo(w, py(baseline));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (head) {
    const x = px(n - 1);
    const y = py(values[n - 1]);
    ctx.beginPath();
    ctx.fillStyle = alpha(color, 0.22);
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = alpha(color, 1);
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
