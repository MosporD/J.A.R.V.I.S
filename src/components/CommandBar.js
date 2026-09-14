import { Component } from '../core/component.js';
import { store, MODE } from '../core/store.js';
import { audio } from '../core/audio.js';
import { execute, completions, catalogue } from '../core/commands.js';
import { readLocalJSON, writeLocalJSON } from '../core/storage.js';

const HISTORY_KEY = 'jarvis.history';
const HISTORY_MAX = 50;

/**
 * The command prompt.
 *
 * A real <input> does the typing (so IME, mobile keyboards and screen readers
 * all behave), with the visible caret and the inline ghost completion drawn
 * over it. Tab accepts the completion, the arrows walk history, and `/`
 * anywhere on the page brings focus back here.
 */
export class CommandBar extends Component {
  render() {
    this.input = this.$('input');
    this.ghost = this.$('[data-ghost]');
    this.caret = this.$('[data-caret]');
    this.hint = this.$('[data-hint]');
    this.busy = false;

    this.history = this.loadHistory();
    this.cursor = this.history.length;

    this.listen(this.input, 'input', () => this.onInput());
    this.listen(this.input, 'keydown', (event) => this.onKey(event));
    this.listen(this.input, 'focus', () => this.updateCaret());
    this.listen(this.input, 'blur', () => this.updateCaret());
    this.listen(this.input, 'click', () => this.updateCaret());

    // `/` focuses the prompt from anywhere; Escape releases it.
    this.listen(document, 'keydown', (event) => {
      if (event.key === '/' && document.activeElement !== this.input) {
        event.preventDefault();
        this.input.focus();
      } else if (event.key === 'Escape' && document.activeElement === this.input) {
        this.input.blur();
      }
    });

    // Clicking anywhere in the well focuses the field — except on the buttons.
    this.listen(this.el, 'pointerdown', (event) => {
      if (event.target !== this.input && !event.target.closest('button')) {
        event.preventDefault();
        this.input.focus();
      }
    });

    // EXECUTE, and Enter on browsers that submit the form rather than the field.
    if (this.el.tagName === 'FORM') {
      this.listen(this.el, 'submit', (event) => {
        event.preventDefault();
        this.submit();
      });
    }

    this.watch('mode', (mode) => {
      this.busy = mode === MODE.PROCESSING;
      this.input.setAttribute('aria-busy', String(this.busy));
    });

    this.renderHint();
    this.onInput();
  }

  loadHistory() {
    const saved = readLocalJSON(HISTORY_KEY, []);
    return Array.isArray(saved) ? saved : [];
  }

  saveHistory() {
    // Storage unavailable simply means history does not persist.
    writeLocalJSON(HISTORY_KEY, this.history.slice(-HISTORY_MAX));
  }

  /** A curated opening set — alphabetical order is not a recommendation. */
  renderHint() {
    if (!this.hint) return;
    const known = new Set(catalogue().map((c) => c.name));
    const suggested = ['status', 'diag', 'scan', 'locate', 'email', 'say']
      .filter((name) => known.has(name));
    this.hint.textContent = `TRY · ${suggested.join(' · ')}`;
  }

  /** The completion that Tab would accept, or '' when there is none. */
  suggestion() {
    const value = this.input.value;
    if (!value || value.includes(' ')) return '';
    const [match] = completions(value.toLowerCase());
    return match && match !== value.toLowerCase() ? match.slice(value.length) : '';
  }

  onInput() {
    const value = this.input.value;
    if (this.ghost) {
      this.ghost.textContent = value + this.suggestion();
    }
    this.updateCaret();
  }

  /** Park the block caret after the typed text, measured in the real font. */
  updateCaret() {
    if (!this.caret) return;
    const width = this.measure(this.input.value.slice(0, this.input.selectionStart ?? undefined));
    this.caret.style.transform = `translateX(${width}px)`;
  }

  measure(text) {
    if (!this._measure) {
      const canvas = document.createElement('canvas');
      this._measure = canvas.getContext('2d');
    }
    const style = getComputedStyle(this.input);
    this._measure.font = `${style.fontSize} ${style.fontFamily}`;
    const metrics = this._measure.measureText(text);
    // measureText ignores letter-spacing, so add it back per character.
    const spacing = parseFloat(style.letterSpacing) || 0;
    return metrics.width + spacing * text.length;
  }

  onKey(event) {
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        this.submit();
        break;

      case 'Tab': {
        const suggestion = this.suggestion();
        if (suggestion) {
          event.preventDefault();
          this.input.value += suggestion;
          audio.hover();
          this.onInput();
        }
        break;
      }

      case 'ArrowUp':
        event.preventDefault();
        this.recall(-1);
        break;

      case 'ArrowRight':
        // Right arrow at the end of the line also accepts the completion.
        if (this.input.selectionStart === this.input.value.length && this.suggestion()) {
          event.preventDefault();
          this.input.value += this.suggestion();
          this.onInput();
        }
        break;

      case 'ArrowDown':
        event.preventDefault();
        this.recall(1);
        break;

      case 'l':
      case 'k':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          execute('clear');
        }
        break;

      default:
        break;
    }
    requestAnimationFrame(() => this.updateCaret());
  }

  recall(direction) {
    if (!this.history.length) return;
    this.cursor = Math.max(0, Math.min(this.history.length, this.cursor + direction));
    this.input.value = this.history[this.cursor] ?? '';
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    audio.hover();
    this.onInput();
  }

  async submit() {
    const line = this.input.value.trim();
    if (!line) return;

    audio.click();
    this.history.push(line);
    if (this.history.length > HISTORY_MAX) this.history.shift();
    this.cursor = this.history.length;
    this.saveHistory();

    this.input.value = '';
    this.onInput();

    await execute(line);
    if (store.get('mode') === MODE.PROCESSING) store.set('mode', MODE.IDLE);
  }
}
