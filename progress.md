# J.A.R.V.I.S. — Progress

Living status file. Update it at the end of each session; append to the log
rather than rewriting history.

**Last updated:** 2026-09-15 · **Branch:** `c/kind-meitner-l66v5c` · **PR:** [#4](https://github.com/MosporD/J.A.R.V.I.S/pull/4) → `main`

---

## Snapshot

| | |
|---|---|
| Build | ✅ passes |
| Main bundle | 106.96 kB / 38.02 kB gzip |
| Lazy 3D chunk | 542.59 kB / 135.93 kB gzip — split out of main |
| `npm test` | ✅ **29/29**, committed to the repo |
| forge pytest | ✅ 6 passed, 38 skipped, 0 errors |
| CI | ✅ `.github/workflows/ci.yml` — dashboard + forge |
| PR stack | ✅ **unstacked** — PR #4 targets `main` directly |
| Gestures | ✅ built, frame-differencing |

---

## What exists

### Dashboard

The reactor core (2D canvas, and a 3D rebuild that follows the flat core's
drawing list element for element), telemetry panels, an event stream, a command
prompt with a directive registry, boot sequence, themes, and an audio layer.

### Input paths

| Path | How | Leaves the machine? |
|---|---|---|
| Prompt | typed directives | no |
| Hotkeys | `hotkeys.js`, `v` ear / `g` optics / `p` cast | no |
| Voice in | Web Speech API | **yes — Chrome streams audio to Google** |
| Voice out | Speech Synthesis | no |
| Gestures | camera + frame differencing | no |
| Casting | Presentation API + QR | no |
| Email | `mailto:` hand-off | no backend, no credentials |

### Gestures

Frame differencing, not a hand-tracking model. Each frame is drawn to a 40×30
canvas, reduced to brightness, and differenced against the last; the moving
cells give an energy figure and a centroid, and a small state machine turns a
travelling centroid into a swipe.

It cannot tell a thumbs-up from a peace sign. It knows only that something
moved, roughly where, and which way. What it buys is that it works offline,
adds nothing to the bundle, needs no CDN, and can be tested without a camera.

| Gesture | Directive |
|---|---|
| swipe up | `status` |
| swipe down | `clear` |
| swipe left | `scan` |
| swipe right | `diag` |
| push | pulse the reactor |

Thresholds were measured, not guessed — a disc of known size swept across the
grid, peak energy recorded against the fraction of frame it covers:

```
covers   2.4%   4.2%   6.5%   9.4%  12.8%  16.8%  26.2%
energy  0.031  0.041  0.057  0.064  0.075  0.087  0.112
```

A hand at arm's length covers 10–25% of a 320×240 frame, arriving around
0.06–0.11. The start gate sits at 0.035 so a hand held further back still
registers.

---

## Testing

`npm test` — 29 checks, committed, no external services.

| Suite | Checks | What it covers |
|---|---|---|
| `test/gesture-detector.test.mjs` | 17 | swipe classification in all four directions, mirroring, push, still and empty frames, jitter rejection, flailing rejection, cooldown, stroke cut-off, reset, luma weighting |
| `test/dashboard.test.mjs` | 12 | boot, 3D core mount and brightness, flat-core fallback, context loss, reduced motion, portrait resize, gesture toggle, camera pipeline end to end, hardware release, directives |

The detector is a separate module (`src/core/gesture-detector.js`) with **no
imports at all**, so its logic runs in Node in milliseconds with no browser,
no webcam and no permission prompt. `gestures.js` is the thin camera glue.

### Traps this harness already paid for

- **`readPixels` on a WebGL canvas returns zeros** once the frame is
  composited, unless `preserveDrawingBuffer` is set. Measure the composited
  screenshot instead — a suite written the other way reports a black core that
  is rendering perfectly.
- **Never `networkidle`.** `forge.start()` polls a pipeline that is not running
  in a test, so the network never goes idle.
- **Never `pkill -f 'vite preview'`** — that pattern matches the killing
  shell's own command line. Kill by port.
- **Playwright's pinned Chromium build may not be the one installed.**
  `test/browser.mjs` resolves the browser by searching, and honours
  `JARVIS_CHROMIUM`.

### forge

`forge/pipeline/tests/` — 6 passed, 38 skipped, 0 errors. Skips want a live
Postgres (`FORGE_TEST_DATABASE_URL`) or ffmpeg; both are honest.

Do **not** put the container's Playwright ffmpeg
(`/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux`) on `PATH`. It is a capture-only
build, so the availability probe passes and 11 clean skips turn into errors.

---

## Open decisions

- [ ] **Mark PR #4 ready for review?** Still a draft.
- [ ] **Close PR #2 and PR #3** once #4 merges — their commits are contained in
      it, so they would merge nothing.
- [ ] **Stand up a test Postgres** to unskip forge's 26 database tests, or
      accept them as permanently skipped.

---

## The goal: the J.A.R.V.I.S. of the films

Worth being straight about the gap. What exists is a **command surface** — it
looks the part, it responds, and every panel is driven by real state. The
J.A.R.V.I.S. of the films is four things this is not:

1. **Conversational reasoning.** It answers questions it was never programmed
   for. Here, a directive registry matches known verbs. Closing this means a
   language model behind the prompt.
2. **Real telemetry.** It reads actual systems. Here, the figures are
   simulated — except forge, which is real.
3. **Agency.** It acts in the world: runs analyses, controls hardware. Here,
   nothing outside the tab moves.
4. **Persistent memory.** It remembers across sessions. Here, nothing survives
   a reload except a few browser-local preferences.

The nearest genuine step is (1) plus (2): put a model behind the prompt with
tool-calls into the directive registry, and point the telemetry at something
real. Given the day job, that "something real" is the obvious candidate — a
read-only feed from network tooling would turn the dashboard from a
convincing prop into an instrument that tells you something you did not know.

---

## Local recovery

```bash
git fetch origin
git checkout -B c/kind-meitner-l66v5c origin/c/kind-meitner-l66v5c
npm install
npx playwright install chromium   # first run only
npm test
npm run dev
```

---

## Update log

- **2026-09-15 (2)** — Acted on the audit. Built gesture directives by frame
  differencing, with thresholds measured rather than guessed. Committed the
  test harness: 29 checks, `npm test`, no external services. Added CI for both
  the dashboard and forge. Fixed forge's `media` fixture so a missing ffmpeg
  skips instead of erroring. Switched the 3D core's materials to front faces
  only — drawing both sides pushed the bright passes past what the framebuffer
  holds, clipping saturated cyan towards white. **Unstacked the PRs:** PR #4
  now targets `main`.
  Two bugs the new harness caught immediately: the `gesture` directive read its
  argument as a string when the registry passes an array, and the detector's
  start gate was set above what a normal hand produces.
- **2026-09-15** — Full recheck. Found that the JavaScript suites this file
  cited did not exist in the repository and corrected the claim. Fixed four
  defects in the 3D core: ripples thickened as they grew, `paintOrbiters`
  allocated per frame, `resize()` ignored device pixel ratio changes, and a
  disposed renderer kept its WebGL context.
- **2026-09-14 (2)** — Rebuilt the 3D reactor core against the 2D renderer.
  Corrected stroke widths measured against half the real panel size, two
  containment rings turned edge-on into straight lines, a triangle pointing
  right instead of up, and a camera set too far back.
- **2026-09-14** — Operator confirmed the stuck-boot symptom cleared on their
  own Windows hardware. All three causes closed.
