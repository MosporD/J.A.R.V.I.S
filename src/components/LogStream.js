import { Component } from '../core/component.js';
import { clockTime } from '../core/format.js';
import { prefersReducedMotion } from '../core/ticker.js';

const MAX_LINES = 220;

/**
 * The terminal log.
 *
 * Anything on the `log` channel lands here. J.A.R.V.I.S.'s own replies are
 * typed out character by character; everything else prints immediately.
 * Auto-scroll suspends while the operator is reading further up, and resumes
 * the moment they return to the bottom.
 */
export class LogStream extends Component {
  render() {
    this.stream = this.$('[data-log-stream]');
    this.badge = this.$('[data-log-count]');
    this.pinned = true;
    this.count = 0;
    this.filter = 'all';
    this.typing = null;
    this.queue = [];

    this.listen(this.stream, 'scroll', () => {
      const distance =
        this.stream.scrollHeight - this.stream.scrollTop - this.stream.clientHeight;
      this.pinned = distance < 24;
      this.el.dataset.pinned = String(this.pinned);
    });

    this.$$('[data-filter]').forEach((button) => {
      this.listen(button, 'click', () => this.setFilter(button.dataset.filter));
    });

    this.on('log', (entry) => this.push(entry));
    this.on('log:clear', () => this.clear());
    this.track(() => clearInterval(this.typing));
  }

  setFilter(filter) {
    this.filter = filter;
    this.$$('[data-filter]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    });
    this.stream.dataset.filter = filter;
    for (const line of this.stream.children) {
      const level = line.dataset.level;
      const show =
        filter === 'all' ||
        (filter === 'alerts' && (level === 'alert' || level === 'warn')) ||
        (filter === 'dialogue' && (level === 'jarvis' || level === 'user'));
      line.hidden = !show;
    }
  }

  push({ level = 'sys', tag = 'sys', text = '', typed = false }) {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.dataset.level = level;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = clockTime();

    const label = document.createElement('span');
    label.className = 'log-tag';
    label.textContent = `[${tag}]`;

    const body = document.createElement('span');
    body.className = 'log-text';

    line.append(time, label, body);
    this.stream.append(line);
    this.count += 1;
    if (this.badge) this.badge.textContent = String(this.count).padStart(4, '0');

    while (this.stream.children.length > MAX_LINES) this.stream.firstElementChild.remove();

    if (typed && !prefersReducedMotion) this.typeInto(body, text);
    else body.textContent = text;

    this.setFilter(this.filter);
    this.scroll();
  }

  /** Character-by-character reveal, queued so lines never interleave. */
  typeInto(node, text) {
    this.queue.push({ node, text });
    if (this.typing) return;
    this.drainQueue();
  }

  drainQueue() {
    const job = this.queue.shift();
    if (!job) {
      this.typing = null;
      return;
    }
    let i = 0;
    this.typing = setInterval(() => {
      i += 1;
      job.node.textContent = job.text.slice(0, i);
      this.scroll();
      if (i >= job.text.length) {
        clearInterval(this.typing);
        this.drainQueue();
      }
    }, 14);
  }

  scroll() {
    if (this.pinned) this.stream.scrollTop = this.stream.scrollHeight;
  }

  clear() {
    this.stream.replaceChildren();
    this.count = 0;
    if (this.badge) this.badge.textContent = '0000';
    this.pinned = true;
  }
}
