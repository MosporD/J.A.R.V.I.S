/**
 * Bridge between the CSS design tokens and the canvas renderers.
 *
 * The 2D canvas cannot resolve `var(--color-hud)`, so every renderer asks this
 * module for concrete colour strings. Values are read once from the computed
 * root style and cached; `refresh()` re-reads them after a runtime re-hue.
 */

const cache = new Map();
let rootStyle = null;

function style() {
  if (!rootStyle) rootStyle = getComputedStyle(document.documentElement);
  return rootStyle;
}

/** Read a CSS custom property, e.g. token('--color-hud') -> '#00f3ff'. */
export function token(name, fallback = '#00f3ff') {
  if (cache.has(name)) return cache.get(name);
  const value = style().getPropertyValue(name).trim() || fallback;
  cache.set(name, value);
  return value;
}

/** Drop the cache — call after writing new custom properties on :root. */
export function refresh() {
  cache.clear();
  rootStyle = null;
}

/** Hex/rgb colour with an alpha channel, safe for canvas fill/stroke. */
export function alpha(color, a) {
  const hex = color.startsWith('#') ? color : null;
  if (!hex) return color;
  let r;
  let g;
  let b;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** The palette, resolved lazily so a re-hue is picked up on the next frame. */
export const palette = {
  get hud() { return token('--color-hud', '#00f3ff'); },
  get arc() { return token('--color-arc', '#0066ff'); },
  get alert() { return token('--color-alert', '#ff3300'); },
  get caution() { return token('--color-caution', '#ffb000'); },
  get ink() { return token('--color-ink', '#cbeaf7'); },
  get inkDim() { return token('--color-ink-dim', '#7fa3b8'); },
  get inkMute() { return token('--color-ink-mute', '#3f5f75'); },
  get void() { return token('--color-void', '#020408'); },
};

/** Severity -> colour, the one place the mapping is decided. */
export function toneColor(tone) {
  if (tone === 'alert') return palette.alert;
  if (tone === 'warn') return palette.caution;
  if (tone === 'dim') return palette.inkMute;
  return palette.hud;
}
