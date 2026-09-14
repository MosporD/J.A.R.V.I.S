import { bus } from './bus.js';
import { store } from './store.js';
import { execute, register, log, respond } from './commands.js';

/**
 * Global keyboard shortcuts.
 *
 * Single unmodified letters, in the manner of Gmail or GitHub, rather than
 * chords. Modified combinations are the browser's: Ctrl+D, Alt+F and friends
 * all mean something already, and a dashboard that steals them is a dashboard
 * that breaks the browser. Anything held with a modifier is therefore passed
 * straight through.
 *
 * Keys are inert while the operator is typing, and while the start-up sequence
 * is still running — a keypress there means "skip", and it would be unhelpful
 * for it to also fire a directive.
 */

const bindings = new Map();

/**
 * @param {string} key      a single lowercase character
 * @param {string} summary  what it does, as shown by `keys`
 * @param {string|Function} action  a directive to execute, or a function
 */
export function bindKey(key, summary, action) {
  bindings.set(key.toLowerCase(), { key: key.toLowerCase(), summary, action });
}

export function keyBindings() {
  return [...bindings.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** True when the keystroke belongs to whatever the operator is typing into. */
function isTyping(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function startHotkeys() {
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event.target)) return;
    // During start-up every key means "skip the sequence".
    if (!store.get('booted')) return;

    const binding = bindings.get(event.key.toLowerCase());
    if (!binding) return;

    event.preventDefault();
    bus.emit('hotkey', { key: binding.key });
    if (typeof binding.action === 'function') binding.action();
    else execute(binding.action);
  });
}

// --- The default set ---------------------------------------------------------

bindKey('s', 'System status', 'status');
bindKey('d', 'Run diagnostics', 'diag');
bindKey('c', 'Sweep for contacts', 'scan');
bindKey('l', 'Locate this position', 'locate');
bindKey('t', 'Cycle the palette', 'theme next');
bindKey('x', 'Purge the event stream', 'clear');
bindKey('b', 'Replay the start-up sequence', 'boot');
bindKey('h', 'List every directive', 'help');
bindKey('?', 'List every directive', 'help');
bindKey('k', 'List these shortcuts', () => showKeys());
bindKey('f', 'Full screen', () => toggleFullscreen());

function toggleFullscreen() {
  const root = document.documentElement;
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
    return;
  }
  const request = root.requestFullscreen?.bind(root) || root.webkitRequestFullscreen?.bind(root);
  if (!request) {
    log('This browser will not go full screen from a script.', 'warn', 'keys');
    return;
  }
  Promise.resolve(request()).catch((error) => {
    log(`Full screen refused — ${error.message}`, 'warn', 'keys');
  });
}

function showKeys() {
  log('KEYBOARD SHORTCUTS', 'ok', 'keys');
  for (const binding of keyBindings()) {
    log(`  ${binding.key.padEnd(10)} ${binding.summary}`, 'sys', 'keys');
  }
  log('  /          Focus the prompt', 'sys', 'keys');
  log('  Esc        Release the prompt', 'sys', 'keys');
  log('Shortcuts are inert while you are typing.', 'sys', 'keys');
  return respond('Shortcut index displayed, sir.');
}

register({
  name: 'keys',
  aliases: ['shortcuts', 'hotkeys'],
  summary: 'List the keyboard shortcuts.',
  run() {
    return showKeys() ?? Promise.resolve();
  },
});
