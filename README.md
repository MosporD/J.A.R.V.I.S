# J.A.R.V.I.S. — Command Interface

A holographic sci-fi dashboard: a pulsing arc-reactor core, live system
diagnostics, a reactive audio visualiser, a world clock with a position radar,
and a terminal you can actually talk to.

Built with **Vite 8**, **Tailwind CSS v4** and plain ES modules — no UI
framework, no runtime dependencies, no external network calls.

```bash
npm install
npm run dev      # http://localhost:5173
```

| Script            | What it does                                  |
| ----------------- | --------------------------------------------- |
| `npm run dev`     | Dev server with hot reload                    |
| `npm run build`   | Production bundle into `dist/`                |
| `npm run preview` | Serve the built bundle on port 4173           |

---

## Using it

Type into the prompt at the bottom (`/` focuses it from anywhere), or press the
directive keys in the bottom-right panel.

| Directive              | Effect                                                     |
| ---------------------- | ---------------------------------------------------------- |
| `help`                 | List every directive                                       |
| `status`               | Full systems report                                        |
| `diag`                 | Staged diagnostic sweep                                    |
| `scan`                 | Perimeter sweep                                            |
| `locate`               | Resolve real coordinates via the Geolocation API           |
| `time [city]`          | Local time, or time in a tracked city (`time tokyo`)       |
| `reactor <0-100>`      | Set arc output — watch the power grid brown out below ~70  |
| `alert <warn\|critical> <msg>` | Raise an anomaly; `critical` re-colours the core   |
| `theme <name>`         | Re-hue the whole interface: cyan, arc, amber, crimson, viridian |
| `say <text>`           | Speak a line, driving the waveform and core bloom          |
| `mic on` / `mic off`   | Microphone-reactive visualiser (asks permission)           |
| `sfx` / `voice`        | Toggle interface cues and spoken replies                   |
| `boot`                 | Replay the start-up sequence                               |
| `clear`                | Purge the log                                              |

Anything unrecognised gets a conversational reply rather than an error.

**Prompt keys** — `Tab` accepts the ghost completion, `↑`/`↓` walk history
(persisted to `localStorage`), `Ctrl/⌘+K` clears, `Esc` releases focus.

The primitives are on `window.JARVIS` (`bus`, `store`, `telemetry`, `audio`,
`execute`) if you want to drive it from the console.

---

## How it fits together

```
index.html              layout shell — every panel is a mount point
src/
  main.js               bootstrap: mounts components, wires global handlers
  styles/
    index.css           entry; import order is documented in the file
    fonts.css           self-hosted @font-face (see "Offline" below)
    theme.css           @theme design tokens — this IS the Tailwind config
    base.css            substrate, ambient field, reduced-motion policy
    components.css      panel/chip/meter/terminal chassis + custom utilities
  core/
    bus.js              pub/sub — the only way panels talk to each other
    store.js            flat observable state (mode, threat, reactor, …)
    ticker.js           ONE requestAnimationFrame loop for the whole page
    component.js        Component / CanvasComponent / Readout base classes
    telemetry.js        4 Hz sampler: real signals where available, else simulated
    audio.js            synthesised cues + the analyser the waveform reads
    speech.js           TTS wrapper and the amplitude envelope
    commands.js         command registry, parser, and the conversational fallback
    canvas.js           DPR sizing, grids, area traces
    theme.js            bridge from CSS custom properties to canvas colours
    format.js           time, byte, coordinate and easing helpers
  components/           one file per panel; each extends Component
```

Three rules keep it modular:

1. **Panels never reference each other.** All cross-talk goes through `bus` and
   `store`, so removing a panel means deleting one line in `main.js` and its
   markup — nothing else breaks.
2. **A component only touches its own subtree.** Read-outs that live in another
   panel's markup get a `Readout` component or are injected by the caller. A
   component that queries across the DOM fails silently when the layout moves.
3. **One render loop.** Every animated surface registers with `ticker`, which
   also measures the frame rate the diagnostics panel reports.

## Design system

`src/styles/theme.css` is the single source of truth. In Tailwind v4 the
`@theme` block *is* the configuration: each token becomes both a CSS custom
property and a utility class.

```css
--color-hud: #00f3ff;    /* -> bg-hud, text-hud, border-hud/30, … */
--color-arc: #0066ff;
--color-alert: #ff3300;  /* critical only, used sparingly */
--color-caution: #ffb000;
--color-void: #020408;
```

Canvas renderers read the same properties through `core/theme.js`, which is why
`theme amber` re-hues the reactor, the traces and the radar along with the CSS.

Severity is one consistent scale everywhere — cyan nominal, amber degraded, red
critical — driven by `data-tone` attributes rather than composed class strings,
so nothing depends on Tailwind seeing a dynamically built class name.

## Real data vs. simulated

The dashboard prefers a genuine signal wherever the browser exposes one:

| Real                                             | Simulated                     |
| ------------------------------------------------ | ----------------------------- |
| Frame rate (measured in `ticker`)                | CPU, GPU, uplink, temperature |
| JS heap (`performance.memory`, Chromium)         | Arc reactor output            |
| Core count, device memory, connection type       | Power distribution shares     |
| Online/offline, battery, geolocation, every clock | Radar contacts               |

Where a figure is unavailable the panel prints `N/D` rather than inventing one.

## Offline, and other details

- **Fonts are self-hosted** (`public/fonts`, ~80 KB): Orbitron, Share Tech Mono
  and Rajdhani latin subsets. No CDN request, no flash of fallback text, and the
  interface renders correctly on a machine with no network at all.
- **No audio assets.** Every cue is synthesised with oscillators and a generated
  noise buffer. The browser blocks audio until the first gesture, so the engine
  stays dormant and unlocks itself on first interaction.
- **Speech is optional.** The amplitude envelope is driven by the text, not by
  the synthesiser, so the visualiser behaves identically on a machine with no
  installed voices — or with `voice off`.
- **The viewport fit is conditional.** On a display at least 960px tall the
  shell is sized to the viewport, the columns scroll inside themselves and the
  prompt stays anchored. Below that the page becomes an ordinary scrolling
  document rather than squeezing panels past legibility — an honest scrollbar
  beats a panel sliced in half. See the height budget at the end of
  `components.css`.
- **`prefers-reduced-motion` is honoured**: the ambient scan and grain are
  removed, animations collapse, the boot sequence prints instantly and the
  typewriter effect is skipped. Everything stays legible and functional.
- Panels have real landmarks and labels, the log is an `aria-live` region, the
  prompt is a real labelled `<input>`, and toggles carry `aria-pressed`.

## Browser support

Chromium 111+, Safari 16.4+, Firefox 113+ — the floor is `color-mix()`, which
lands last of the features used here. `createConicGradient` (the radar's
phosphor trail), `performance.memory` (heap) and the Battery Status API are all
feature-detected and degrade quietly where they are missing.

## Extending it

Add a directive:

```js
import { register, respond } from './core/commands.js';

register({
  name: 'suit',
  summary: 'Report suit readiness.',
  run(args) {
    return respond('Mark VII is on the platform and fuelled, sir.');
  },
});
```

Add a panel: give it a mount point in `index.html`, extend `Component` (or
`CanvasComponent` for a canvas), and add one line to the `dashboard` array in
`main.js`. Use `this.on()`, `this.watch()`, `this.listen()` and `this.animate()`
so teardown is handled for you.
