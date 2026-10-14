import { Component } from '../core/component.js';
import { cast, qrSVG, shareURL, isLocalOnly } from '../core/cast.js';
import { store } from '../core/store.js';
import { audio } from '../core/audio.js';
import { log } from '../core/commands.js';

/**
 * The cast overlay.
 *
 * Deliberately not a panel in the grid: it is a modal errand — put this on
 * another screen, then get out of the way. It renders on open rather than at
 * mount, so the QR always encodes the address the operator is actually on.
 */
export class CastPanel extends Component {
  render() {
    this.qr = this.$('[data-cast-qr]');
    this.url = this.$('[data-cast-url]');
    this.note = this.$('[data-cast-note]');
    this.deviceButton = this.$('[data-cast-device]');

    this.on('cast:open', () => this.open());
    this.on('cast:close', () => this.close());

    this.listen(this.el, 'click', (event) => {
      if (event.target === this.el) this.close();          // click the backdrop
      if (event.target.closest('[data-cast-dismiss]')) this.close();
      if (event.target.closest('[data-cast-device]')) cast.start();
      if (event.target.closest('[data-cast-detach]')) cast.detach();
      if (event.target.closest('[data-cast-copy]')) this.copy();
    });

    this.listen(window, 'keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) this.close();
    });

    this.watch('casting', (on) => {
      if (!this.deviceButton) return;
      this.deviceButton.textContent = on ? 'STOP CASTING' : 'CAST TO DEVICE';
      this.deviceButton.setAttribute('aria-pressed', String(Boolean(on)));
    });
  }

  get isOpen() {
    return this.el.dataset.open === 'true';
  }

  open() {
    const url = shareURL();
    if (this.qr) this.qr.innerHTML = qrSVG(url);
    if (this.url) this.url.textContent = url;

    if (this.note) {
      const { ok, why } = cast.availability;
      const local = isLocalOnly(url);
      this.note.textContent = local
        ? 'This address only resolves on this machine. Start the dev server with --host and use the network address it prints.'
        : ok
          ? 'Scan from any device on this network, or cast to a display.'
          : why;
      this.note.dataset.tone = local || !ok ? 'warn' : 'ok';
    }

    if (this.deviceButton) this.deviceButton.disabled = !cast.availability.ok;

    this.el.dataset.open = 'true';
    this.el.removeAttribute('hidden');
    audio.confirm();
  }

  close() {
    this.el.dataset.open = 'false';
    this.el.setAttribute('hidden', '');
  }

  async copy() {
    try {
      await navigator.clipboard.writeText(shareURL());
      log('Address copied to the clipboard.', 'ok', 'cast');
    } catch {
      // Clipboard access is refused in plenty of ordinary situations; the
      // address is on screen regardless, so this is a convenience, not a path.
      log('Clipboard refused — the address is shown above.', 'warn', 'cast');
    }
  }
}
