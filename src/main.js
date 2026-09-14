import './styles/index.css';

import { bus } from './core/bus.js';
import { store } from './core/store.js';
import { telemetry } from './core/telemetry.js';
import { audio, bindInterfaceSounds } from './core/audio.js';
import { execute } from './core/commands.js';
import { startHotkeys } from './core/hotkeys.js';
import { speech } from './core/speech.js';
import { forge } from './core/forge.js';
import { narrator } from './core/narrator.js';
import { prefersReducedMotion } from './core/ticker.js';
import { sigil } from './core/format.js';

import { Readout } from './core/component.js';
import { StatusBar } from './components/StatusBar.js';
import { ArcCore, coreStateLabel } from './components/ArcCore.js';
import { supportsWebGL } from './core/webgl.js';
import { Waveform } from './components/Waveform.js';
import { Diagnostics } from './components/Diagnostics.js';
import { WorldClock } from './components/WorldClock.js';
import { PowerGrid } from './components/PowerGrid.js';
import { AlertsPanel, ThreatBadge } from './components/AlertsPanel.js';
import { LogStream } from './components/LogStream.js';
import { CommandBar } from './components/CommandBar.js';
import { ForgePanel, ForgeLink } from './components/ForgePanel.js';
import { NarrateToggle } from './components/NarrateToggle.js';
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
  new BootSequence('#boot'),       // second: the overlay blocks the whole
                                   // viewport, so it is never a casualty of a
                                   // panel further down this list failing
  new StatusBar('#statusbar'),
  new Diagnostics('#diagnostics'),
  new PowerGrid('#power'),
  new ArcCore('#core'),            // upgraded to the 3D core below, if it loads
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
  new NarrateToggle('#narrate-toggle'),
  new CommandBar('#command'),
];

/**
 * Mount one panel without letting it take the others with it.
 *
 * `forEach` over bare `mount()` calls meant the first panel to throw ended the
 * loop, so a single unsupported browser API anywhere in this list left every
 * panel after it unmounted — the boot overlay included, which then sat over the
 * interface at full opacity forever. A dashboard that loses its radar should
 * lose its radar, not its start-up sequence.
 */
function mountSafely(component) {
  const id = component.el?.id || component.constructor.name;
  try {
    component.mount();
  } catch (error) {
    console.error(`[mount] ${id} failed`, error);
    bus.emit('panel:failed', { id, error });
    bus.emit('log', {
      level: 'alert',
      tag: 'mount',
      text: `Panel "${id}" failed to initialise — ${error.message}`,
    });
  }
}

/**
 * Replace whatever is currently drawing the core.
 *
 * A canvas keeps the first context type it is given, so swapping between a 2D
 * and a WebGL core means replacing the element, not just the component.
 */
function swapCore(build) {
  const host = document.querySelector('#core');
  const stale = host?.querySelector('canvas');
  const index = dashboard.findIndex((component) => component.el === host);
  if (!host || !stale || index === -1) return false;

  dashboard[index].destroy();
  const fresh = document.createElement('canvas');
  fresh.className = stale.className;
  fresh.setAttribute('aria-hidden', 'true');
  stale.replaceWith(fresh);
  dashboard[index] = build();
  mountSafely(dashboard[index]);
  return dashboard[index].mounted;
}

/**
 * Load the 3D core in the background and swap it in once it arrives.
 *
 * Three.js is by far the largest thing this page can pull, so it is not allowed
 * to sit between the operator and a working dashboard: the flat core mounts
 * immediately and the 3D one replaces it only if the machine can render it and
 * the chunk actually loads. A blocked CDN, a proxy, or no GPU all end the same
 * way — the flat core, already on screen, simply stays.
 */
async function upgradeCore() {
  if (!supportsWebGL()) {
    bus.emit('log', { level: 'sys', tag: 'core', text: 'No WebGL on this display — flat core retained.' });
    return;
  }
  try {
    const { ArcCore3D } = await import('./components/ArcCore3D.js');
    if (swapCore(() => new ArcCore3D('#core'))) {
      bus.emit('log', { level: 'ok', tag: 'core', text: 'Reactor housing rendered in three dimensions.' });
    }
  } catch (error) {
    console.error('[core] 3D upgrade failed', error);
    bus.emit('log', { level: 'warn', tag: 'core', text: `3D core unavailable — ${error.message}` });
  }
}

/** Losing the GPU mid-session must not cost the core. */
function bindCoreFallback() {
  bus.on('core:fallback', () => swapCore(() => new ArcCore('#core')));
}

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

/** Run one piece of start-up wiring, reporting rather than aborting on failure. */
function step(label, fn) {
  try {
    fn();
  } catch (error) {
    console.error(`[start] ${label} failed`, error);
    bus.emit('log', {
      level: 'alert',
      tag: 'start',
      text: `${label} failed to start — ${error.message}`,
    });
  }
}

function start() {
  // These run before any panel mounts, so an exception in one of them used to
  // mean nothing mounted at all — boot overlay included.
  step('Telemetry', () => telemetry.start());
  // Optional by design: the workshop runs whether or not the pipeline is up,
  // so this backs off quietly instead of retrying a dead port forever.
  step('Forge pipeline', () => forge.start());
  step('Narrator', () => narrator.start());
  step('Interface audio', () => bindInterfaceSounds());
  step('Quick actions', () => bindQuickActions());
  step('Ambient log', () => bindAmbientLog());
  step('Keyboard shortcuts', () => startHotkeys());
  step('Motion preference', () => store.set('reduceMotion', prefersReducedMotion));

  dashboard.forEach(mountSafely);
  bindCoreFallback();
  upgradeCore();

  bus.emit('log', { level: 'sys', tag: 'kernel', text: `Session ${sigil()} opened.` });
  bus.emit('log', { level: 'sys', tag: 'kernel', text: 'Type "help" for the directive index, "keys" for shortcuts. Press "/" to focus the prompt.' });

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
  window.JARVIS = { bus, store, telemetry, forge, narrator, audio, speech, execute, dashboard };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
