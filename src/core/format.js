/** Small, dependency-free formatters shared by every readout. */

export const pad = (n, width = 2) => String(Math.floor(n)).padStart(width, '0');

/**
 * `Intl.DateTimeFormat` throws a RangeError on a time zone the platform does
 * not carry, and a browser built against a trimmed ICU carries very few. Every
 * clock in the HUD goes through here so an unknown zone degrades to local time
 * instead of taking the panel — and, before the mount loop was isolated, the
 * whole interface — down with it.
 */
function formatter(options) {
  try {
    return new Intl.DateTimeFormat('en-GB', options);
  } catch {
    const { timeZone, ...rest } = options;
    return new Intl.DateTimeFormat('en-GB', rest);
  }
}

/** The browser's own zone, or null when it declines to name one. */
export function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** 14:07:32 — the HUD clock format. */
export function clockTime(date = new Date(), timeZone) {
  const parts = formatter({
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

/** SAT 19 AUG 2026 */
export function stardate(date = new Date(), timeZone) {
  return formatter({
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone,
  })
    .format(date)
    .replace(/,/g, '')
    .toUpperCase();
}

/** Hour 0-23 in a given zone — used for the day/night indicator. */
export function hourIn(timeZone, date = new Date()) {
  return Number(
    formatter({ hour: '2-digit', hour12: false, timeZone })
      .format(date)
      .slice(0, 2),
  );
}

/** 04:11:09 from a second count. */
export function duration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
}

/** 1.4 GB / 812 MB — compact byte sizes. */
export function bytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export const pct = (n, digits = 0) => `${n.toFixed(digits)}%`;

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent easing toward a target. */
export const approach = (current, target, dt, speed = 6) =>
  lerp(current, target, 1 - Math.exp(-speed * dt));

/** Deterministic pseudo-random in [0,1) from an integer seed. */
export function seeded(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** A 6-character hex identifier — decoration for log lines and alerts. */
export function sigil() {
  return Math.random().toString(16).slice(2, 8).toUpperCase();
}

/** 51.5074 -> 51°30'26"N */
export function dms(value, positive, negative) {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = Math.round((minFloat - min) * 60);
  return `${deg}°${pad(min)}'${pad(sec)}"${value >= 0 ? positive : negative}`;
}
