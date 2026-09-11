import './styles/index.css';

import { bus } from './core/bus.js';
import { store } from './core/store.js';
import { telemetry } from './core/telemetry.js';
import { audio, bindInterfaceSounds } from './core/audio.js';
import { execute } from './core/commands.js';
import { forge } from './core/forge.js';
import { prefersReducedMotion } from './core/ticker.js';
import { sigil } from './core/format.js';

import { Readout } from './core/component.js';
import { StatusBar } from './components/StatusBar.js';
import { ArcCore, coreStateLabel } from './components/ArcCore.js';
import { Waveform } from './components/Waveform.js';
import { Diagnostics } from './components/Diagnostics.js';
import { WorldClock } from './components/WorldClock.js';
import { PowerGrid } from './components/PowerGrid.js';
import { AlertsPanel, ThreatBadge } from './components/AlertsPanel.js';
import { LogStream } from './components/LogStream.js';
import { CommandBar } from './components/CommandBar.js';
import { ForgePanel, ForgeLink } from './components/ForgePanel.js';
import { BootSequence } from './components/BootSequence.js';

/**
 * Bootstrap.
 *
 * Every panel is an independent component mounted onto a node in index.html.
 * They never reference each other — all cross-talk goes through the bus and the
 * store — so a panel can be removed by deleting one line here and its markup.
 */

const dashboard = [
  new LogStream('#logs'),          // first: it must catch every start-up line
  new StatusBar('#statusbar'),
  new Diagnostics('#diagnostics'),
  new PowerGrid('#power'),
  new ArcCore('#core'),
  new Readout('#core-state', {
    keys: ['mode', 'threat'],
    text: (s) => coreStateLabel(s.get('mode'), s.get('threat')),
  }),
  new Readout('#core-value', { keys: ['reactor'], text: (s) => `${s.get('reactor')}%` }),
  new Waveform('#waveform', { label: '#wave-label' }),
  new WorldClock('#worldclock'),
  new AlertsPanel('#alerts'),
  new ThreatBadge('#threat-state'),
  new ForgePanel('#forge'),
  new ForgeLink('#forge-link'),
  new CommandBar('#command'),
  new BootSequence('#boot'),       // last: it greets once everything is live
];

/** Buttons that simply dispatch a directive. */
function bindQuickActions(root = document) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    event.preventDefault();
    execute(button.dataset.command);
  });
}

/** Ambient chatter so an unattended dashboard still feels alive. */
function bindAmbientLog() {
  const NOTES = [
    ['sys', 'Perimeter sensors report no change.'],
    ['sys', 'Suit telemetry archived to local cache.'],
    ['sys', 'Recalibrating repulsor alignment — drift within tolerance.'],
    ['sys', 'Weather model refreshed for tracked regions.'],
    ['sys', 'Encryption keys rotated.'],
    ['sys', 'Workshop environment stable.'],
  ];

  const schedule = () => {
    const delay = 24000 + Math.random() * 40000;
    setTimeout(() => {
      if (store.get('booted') && !document.hidden) {
        const [level, text] = NOTES[Math.floor(Math.random() * NOTES.length)];
        bus.emit('log', { level, tag: `bg·${sigil().slice(0, 3)}`, text });
      }
      schedule();
    }, delay);
  };
  schedule();
}

function start() {
  telemetry.start();
  // Optional by design: the workshop runs whether or not the pipeline is up,
  // so this backs off quietly instead of retrying a dead port forever.
  forge.start();
  bindInterfaceSounds();
  bindQuickActions();
  bindAmbientLog();

  store.set('reduceMotion', prefersReducedMotion);
  dashboard.forEach((component) => component.mount());

  bus.emit('log', { level: 'sys', tag: 'kernel', text: `Session ${sigil()} opened.` });
  bus.emit('log', { level: 'sys', tag: 'kernel', text: 'Type "help" for the directive index. Press "/" to focus the prompt.' });

  if (prefersReducedMotion) {
    bus.emit('log', {
      level: 'sys',
      tag: 'a11y',
      text: 'Reduced-motion preference detected — animation suppressed.',
    });
  }

  // Audio can only start after a gesture. Either modality unlocks it, but the
  // notice is announced once — `{ once: true }` is per-listener, not per-event.
  let unlocked = false;
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    audio.init();
    bus.emit('log', { level: 'ok', tag: 'audio', text: 'Audio subsystem unlocked.' });
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // Expose the primitives for experimentation from the browser console.
  window.JARVIS = { bus, store, telemetry, forge, audio, execute, dashboard };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
