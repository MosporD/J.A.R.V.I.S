import { bus } from './bus.js';
import { store } from './store.js';
import { readLocal, writeLocal } from './storage.js';
import { register, log, respond } from './commands.js';

/**
 * Getting the operator's attention when the operator is not looking.
 *
 * A dashboard that only speaks inside its own tab is a dashboard you have to
 * babysit, which defeats the point of watching anything. This routes what the
 * sentinel raises to the desktop.
 *
 * Restraint is the whole design. Three rules keep it from becoming the thing
 * you mute on day two:
 *
 *   Only when unwatched. A visible tab already shows the alert; posting a
 *   desktop notification over it is telling someone what they are reading.
 *   Critical alerts are the exception.
 *
 *   Quiet hours. Nothing is important enough at 03:00 to be worth training
 *   the operator to dismiss notifications reflexively.
 *
 *   Never for a simulated signal, unless explicitly allowed. Interrupting a
 *   person's evening with a number this dashboard invented is indefensible.
 */

const ENABLED_KEY = 'jarvis.notify';
const QUIET_KEY = 'jarvis.notify.quiet';
const ALLOW_SIM_KEY = 'jarvis.notify.simulated';

const supported = typeof window !== 'undefined' && 'Notification' in window;

class Notifier {
  constructor() {
    this.enabled = readLocal(ENABLED_KEY) === 'on';
    this.allowSimulated = readLocal(ALLOW_SIM_KEY) === 'on';
    this.quiet = this._readQuiet();
    this.sent = new Map();
    store.set('notify', this.enabled);
  }

  get supported() {
    return supported;
  }

  get permission() {
    return supported ? Notification.permission : 'unsupported';
  }

  _readQuiet() {
    const raw = readLocal(QUIET_KEY, '22-7');
    const [from, to] = String(raw).split('-').map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(from) || !Number.isFinite(to)) return { from: 22, to: 7 };
    return { from, to };
  }

  setQuiet(from, to) {
    this.quiet = { from, to };
    writeLocal(QUIET_KEY, `${from}-${to}`);
  }

  /** Quiet hours wrap midnight, so the comparison has two shapes. */
  inQuietHours(date = new Date()) {
    const { from, to } = this.quiet;
    if (from === to) return false;
    const hour = date.getHours();
    return from < to ? hour >= from && hour < to : hour >= from || hour < to;
  }

  /**
   * Must be called from a user gesture — browsers refuse otherwise, and a
   * refusal here is permanent until the user changes it in site settings.
   */
  async enable() {
    if (!supported) {
      log('This browser has no notification support.', 'warn', 'notify');
      return false;
    }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();

    if (permission !== 'granted') {
      log(`Notification permission ${permission}.`, 'warn', 'notify');
      return false;
    }
    this.enabled = true;
    writeLocal(ENABLED_KEY, 'on');
    store.set('notify', true);
    log('Desktop notifications armed.', 'ok', 'notify');
    return true;
  }

  disable() {
    this.enabled = false;
    writeLocal(ENABLED_KEY, 'off');
    store.set('notify', false);
    log('Desktop notifications stood down.', 'sys', 'notify');
  }

  /**
   * Decide whether this particular event earns an interruption.
   * @returns {{ok: boolean, why: string}}
   */
  shouldSend(event) {
    if (!this.enabled) return { ok: false, why: 'notifications off' };
    if (!supported || Notification.permission !== 'granted') {
      return { ok: false, why: 'no permission' };
    }
    if (event.simulated && !this.allowSimulated) {
      return { ok: false, why: 'signal is simulated' };
    }
    if (this.inQuietHours() && event.level !== 'alert') {
      return { ok: false, why: 'quiet hours' };
    }
    if (!document.hidden && event.level !== 'alert') {
      return { ok: false, why: 'tab is visible' };
    }
    // One notification per rule per five minutes, whatever the sentinel does.
    const last = this.sent.get(event.id) ?? 0;
    if (Date.now() - last < 5 * 60 * 1000) return { ok: false, why: 'already sent recently' };

    return { ok: true, why: '' };
  }

  send(event) {
    const verdict = this.shouldSend(event);
    if (!verdict.ok) return verdict;

    try {
      const notification = new Notification(`J.A.R.V.I.S. — ${event.title}`, {
        body: [event.note, event.advice].filter(Boolean).join('\n'),
        tag: `jarvis:${event.id}`,
        renotify: false,
        silent: event.level !== 'alert',
      });
      notification.addEventListener('click', () => {
        window.focus();
        notification.close();
      });
      this.sent.set(event.id, Date.now());
      return { ok: true, why: '' };
    } catch (error) {
      log(`Notification failed — ${error.message}`, 'warn', 'notify');
      return { ok: false, why: error.message };
    }
  }

  start() {
    bus.on('sentinel:raise', (event) => this.send(event));
    return this;
  }
}

export const notifier = new Notifier();

register({
  name: 'notify',
  aliases: ['notifications'],
  summary: 'Desktop notifications — on | off | quiet <from> <to> | status.',
  async run(args) {
    const verb = (args[0] || 'status').toLowerCase();

    if (verb === 'on') {
      const ok = await notifier.enable();
      return ok ? respond('I will let you know, sir.') : Promise.resolve();
    }
    if (verb === 'off') {
      notifier.disable();
      return respond('Very good. Silence it is.');
    }
    if (verb === 'quiet') {
      const from = Number.parseInt(args[1], 10);
      const to = Number.parseInt(args[2], 10);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        log('Usage: notify quiet <fromHour> <toHour>   e.g. notify quiet 22 7', 'warn', 'notify');
        return Promise.resolve();
      }
      notifier.setQuiet(from, to);
      log(`Quiet hours ${String(from).padStart(2, '0')}:00–${String(to).padStart(2, '0')}:00.`, 'ok', 'notify');
      return respond('Quiet hours set.');
    }
    if (verb === 'simulated') {
      notifier.allowSimulated = args[1] !== 'off';
      writeLocal(ALLOW_SIM_KEY, notifier.allowSimulated ? 'on' : 'off');
      log(
        notifier.allowSimulated
          ? 'Simulated signals may now raise desktop notifications. They are still marked as invented.'
          : 'Simulated signals will not interrupt you.',
        'sys',
        'notify',
      );
      return Promise.resolve();
    }

    const { from, to } = notifier.quiet;
    log(`Notifications ${notifier.enabled ? 'ARMED' : 'OFF'} · permission ${notifier.permission}`, 'ok', 'notify');
    log(`Quiet hours ${String(from).padStart(2, '0')}:00–${String(to).padStart(2, '0')}:00`, 'sys', 'notify');
    log(`Simulated signals ${notifier.allowSimulated ? 'may' : 'may not'} interrupt`, 'sys', 'notify');
    log(`Tab currently ${document.hidden ? 'hidden' : 'visible'}`, 'sys', 'notify');
    return Promise.resolve();
  },
});
