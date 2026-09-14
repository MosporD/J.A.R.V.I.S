import qrcode from 'qrcode-generator';
import { bus } from './bus.js';
import { store } from './store.js';
import { register, log, respond } from './commands.js';

/**
 * Putting the dashboard on another screen.
 *
 * Three routes, because no single one covers the cases:
 *
 *   Presentation API — a genuine cast to a Chromecast or a second display.
 *   Chrome and Edge only, and only over HTTPS or localhost.
 *
 *   A link, as text and as a QR code — any phone, tablet or laptop on the
 *   same network opens the dashboard itself. No pairing, no server.
 *
 *   A detached window — the same view popped out, to drag onto a second
 *   monitor.
 *
 * The dashboard holds no state a viewer needs handed to them: every panel
 * derives from live telemetry and the browser's own clock, so a second device
 * that simply opens the URL is showing the same instrument, not a mirror of
 * this one. That is what makes a link sufficient and a signalling server
 * unnecessary.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

/** True when this URL will not resolve from any other device. */
export function isLocalOnly(url = window.location.href) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return true;
  }
}

export function shareURL() {
  return window.location.href;
}

/**
 * A QR as an inline SVG, drawn module by module.
 *
 * The library's own `createSvgTag` hard-codes black; the HUD needs the code in
 * the current accent colour, and `currentColor` lets one path follow a re-hue
 * without regenerating anything.
 */
export function qrSVG(text, { cells = 4, quiet = 2 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = (count + quiet * 2) * cells;
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const x = (col + quiet) * cells;
      const y = (row + quiet) * cells;
      path += `M${x} ${y}h${cells}v${cells}h-${cells}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="QR code for ${text}"><path d="${path}" fill="currentColor"/></svg>`;
}

class Cast {
  constructor() {
    this.request = null;
    this.connection = null;
  }

  /** Presentation needs a secure context; say which is missing, not just "no". */
  get availability() {
    if (!('PresentationRequest' in window)) return { ok: false, why: 'This browser has no Presentation API — Chrome or Edge is required.' };
    if (!window.isSecureContext) return { ok: false, why: 'Casting needs a secure context — serve the dashboard over HTTPS.' };
    return { ok: true, why: '' };
  }

  async start() {
    const { ok, why } = this.availability;
    if (!ok) {
      log(why, 'warn', 'cast');
      return false;
    }
    try {
      this.request = new window.PresentationRequest([shareURL()]);
      const connection = await this.request.start();
      this.connection = connection;
      store.set('casting', true);
      log(`Casting to ${connection.id ? `device ${connection.id}` : 'the selected display'}.`, 'ok', 'cast');

      connection.addEventListener('close', () => this._ended('closed'));
      connection.addEventListener('terminate', () => this._ended('terminated'));
      return true;
    } catch (error) {
      // Dismissing the device picker is a choice, not a fault.
      if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
        log('Cast cancelled.', 'sys', 'cast');
      } else {
        log(`Cast failed — ${error.message}`, 'alert', 'cast');
      }
      return false;
    }
  }

  stop() {
    try {
      this.connection?.terminate();
    } catch {
      /* already gone */
    }
    this._ended('stopped');
  }

  _ended(reason) {
    this.connection = null;
    if (store.get('casting')) log(`Cast ${reason}.`, 'sys', 'cast');
    store.set('casting', false);
  }

  /** A second window of the same dashboard, for a second monitor. */
  detach() {
    const view = window.open(shareURL(), 'jarvis-detached', 'width=1280,height=800');
    if (!view) {
      log('The browser blocked the detached view — allow pop-ups for this page.', 'warn', 'cast');
      return false;
    }
    log('Detached view opened.', 'ok', 'cast');
    return true;
  }
}

export const cast = new Cast();

register({
  name: 'cast',
  aliases: ['share', 'present'],
  summary: 'Put the dashboard on another screen — on | off | detach.',
  run(args) {
    const verb = (args[0] || '').toLowerCase();

    if (verb === 'off' || verb === 'stop') {
      cast.stop();
      bus.emit('cast:close');
      return respond('Cast ended, sir.');
    }
    if (verb === 'detach' || verb === 'window') {
      cast.detach();
      return Promise.resolve();
    }
    if (verb === 'device' || verb === 'on') {
      return cast.start().then(() => undefined);
    }

    bus.emit('cast:open');
    if (isLocalOnly()) {
      log(
        'This address is local to this machine. Restart the dev server with --host and open the network address it prints, or another device cannot reach it.',
        'warn',
        'cast',
      );
    }
    return respond('Cast panel open, sir. Scan the code, or pick a display.');
  },
});
