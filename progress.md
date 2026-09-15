# J.A.R.V.I.S. — Progress

Living status file. Update it at the end of each session; don't rewrite the
history, append to it.

**Last updated:** 2026-09-15 · **Branch:** `c/nifty-clarke-qz3wv2` @ `1698a4e` · **PR:** [#3](https://github.com/MosporD/J.A.R.V.I.S/pull/3) (draft)

---

## Snapshot

| | |
|---|---|
| Build (`npm run build`) | ✅ passes — 42 modules, 1.07s |
| Main bundle | 101.98 kB / 36.42 kB gzip |
| Lazy 3D chunk | 540.77 kB / 135.45 kB gzip — correctly split out of main |
| Automated CI | ❌ none configured on this repo |
| JS test suites | ⚠️ **not in the repo** — ad-hoc scripts, see below |
| forge (Python) suite | 6 passed, 37 skipped, 1 error |
| Diff vs base | 21 files, +1575 / −55, 9 commits |
| 3D core fidelity | ✅ rebuilt against the 2D drawing list — 9/9 render checks |
| Merge conflicts | none — branch is current with its base |
| Stuck-boot symptom | ✅ **cleared on the operator's Windows hardware** (confirmed 2026-09-14) |

---

## ⚠️ The PR stack is the main blocker

The PRs are **stacked**, not independent. Nothing reaches `main` until the
bottom of the stack moves:

```
main (5262639)
  └── PR #2  c/clever-turing-jnvekr (44a9082)   ← draft, open, blocks everything
        └── PR #3  c/nifty-clarke-qz3wv2 (1698a4e)  ← draft, open, all of this session's work
```

PR #3 is based on another session's branch, not `main`. **PR #3 cannot merge
until PR #2 merges.** Both are still drafts. Decide the order before doing
more feature work — a third stacked branch would make this materially worse.

`origin/claude/jarvis-dashboard-ui-vir2rq` (`b8f7990`) is **stale — do not
branch from it.** It predates the Windows build fix and will hand you a
dashboard that won't start.

---

## Shipped

### The stuck-boot bug — three separate causes

Symptom: dashboard frozen on `INITIALISING 0%` forever.

1. **Boot replay cancelled itself.** `execute()` runs a command's `run()`
   synchronously from the prompt's keydown handler, so `bus.emit('boot:replay')`
   set `running = true` while that same Enter was still propagating to the
   window-level skip listener, which killed it. Fixed with a `performance.now()`
   stamp per run.
2. **Any start-up error sealed the HUD behind the overlay.** The mount loop had
   no isolation and `BootSequence` mounted last. Several browser APIs
   (`localStorage` in the `AudioEngine` constructor, `matchMedia`,
   `Intl.DateTimeFormat` with an unknown zone) were touched at module scope,
   where a throw kills the whole module graph.
3. **The actual cause of what the operator saw — my error.** I branched from
   `b8f7990`, which predates `d3d6b27` "Fix the dashboard failing to build on a
   Windows checkout". On Windows, `core.autocrlf` rewrites LF→CRLF,
   `base.css`'s multi-line backslash-continued data URI stops terminating,
   Tailwind fails, the dev server 500s the CSS module, `main.js` never runs.
   **Lesson: verify the base is current before building on it.**

   ✅ **Confirmed cleared on the operator's own Windows machine, 2026-09-14.**
   All three causes are now closed; the original `INITIALISING 0%` report is resolved.

### Commits

| Commit | What |
|---|---|
| `ec65cc5` | Boot replay fix + timer-leak fix |
| `6e02ee1` | Mount isolation; guarded storage / Intl / matchMedia; `index.html` failsafe |
| `d0de762` | Failsafe catches failed module + stylesheet loads (capture phase) |
| `2c1f1ce` | Email directive — `mailto:` compose, no backend, no credentials |
| `7f554f9` | Merge onto the current line (brings in the Windows fix) |
| `eafe231` | 3D reactor core — Three.js, lazily imported |
| `6597782` | Global keyboard shortcuts |
| `70fc1aa` | Voice input — Web Speech API |
| `1698a4e` | Casting — Presentation API + QR/link + detached window |

**New modules:** `src/core/{storage,webgl,hotkeys,dictation,cast}.js` ·
`src/components/{ArcCore3D,ListenToggle,CastPanel}.js`

### The 3D core, rebuilt

The first 3D core was a weaker instrument wearing a WebGL badge. It kept the
state bindings and threw away the visual language: four full torus rings where
the flat core draws four arc segments of unequal length, 36 uniform ticks where
it draws 120 with every tenth major, and no dashed ring, brackets, orbiters,
containment rings or leading markers at all. The dual-pass glow — a wide
translucent stroke under a thin bright one, which is what makes the flat core
read as lit — was never ported, and an icosahedron wireframe appeared that
exists nowhere in the 2D.

It is now the flat core's drawing list rebuilt as geometry, at the same radii,
in the same order, with stroke widths measured against the real panel size
rather than guessed. Depth is the only addition: the segments sit on slightly
separated planes, the orbiters run on genuinely inclined orbits instead of
squashed ellipses, and the assembly leans towards the pointer.
**New deps:** `three@^0.186.0`, `qrcode-generator@^2.0.4`

---

## Not done

### Gesture controls — blocked on a decision, not on effort

Requested, **not built**. MediaPipe's hand landmarker needs a ~7.8 MB runtime
model plus a wasm bundle from a CDN that is blocked in this environment —
untestable here, and plausibly blocked on the Zain corporate network too.

Two options, pick one before any code is written:

| | MediaPipe skeletal tracking | Frame-differencing motion |
|---|---|---|
| Fidelity | real hand poses, per-finger | swipes / coarse motion only |
| Weight | ~7.8 MB model + wasm | negligible, self-contained |
| Network | CDN required at runtime | fully offline |
| Testable here | ❌ no | ✅ yes |

My read: **frame-differencing**. A gesture layer that dies behind a corporate
proxy is worse than no gesture layer. Revisit MediaPipe if the model can be
vendored locally.

---

## Open decisions — need your call

- [ ] **Mark PR #3 ready for review, or keep it draft?** Never confirmed.
- [ ] **Is basing on `c/clever-turing-jnvekr` intended,** or should this be
      rebased onto `main` to unstack it? Never confirmed.
- [ ] **Gestures:** MediaPipe vs frame-differencing (see above).
- [ ] **PR #2 is a draft blocking PR #3** — what's the plan for landing it?

---

## Your local machine

Last seen mid-conflicted-merge with a stash. Clean recovery:

```bash
git merge --abort
git fetch origin
git checkout -B c/nifty-clarke-qz3wv2 origin/c/nifty-clarke-qz3wv2
npm install          # three + qrcode-generator are new
npm run dev
```

⚠️ Your stash (local edits made before pulling the boot fix) touches
`package.json` / `package-lock.json`. Those aren't my changes — likely another
session's local work. **Don't drop it without checking first.**

---

## Testing conventions

### ⚠️ The JavaScript suites are not in the repository

Earlier sessions reported boot 14/14, email 11/11, hotkeys 10/10, voice 28/28
and cast 20/20. Those numbers are real but **unreproducible**: the suites were
ad-hoc scripts written into a session scratchpad, and the scratchpad is gone.
`package.json` has no `test` script and there is not one `.test.js` in the
tree. Nobody — including a future session — can re-run them or tell whether a
change broke them.

Treat every one of those numbers as a claim about a moment that has passed,
not as a standing guarantee.

The 3D core checks below were run this session and are in the same position:
real, passing, and living only in a scratchpad until someone commits them.

| Suite | Result | Committed? |
|---|---|---|
| boot | 14/14 | ❌ lost |
| email | 11/11 | ❌ lost |
| hotkeys | 10/10 | ❌ lost |
| voice | 28/28 | ❌ lost |
| cast | 20/20 | ❌ lost |
| 3D core render | 9/9 | ❌ scratchpad only |

### forge — the one committed suite

`forge/pipeline/tests/` is a real pytest suite that nothing in the dashboard
work has been running. Current state, after installing
`requirements.txt` and `requirements-render.txt`:

```
6 passed, 37 skipped, 1 error
```

The skips are honest — 26 want `FORGE_TEST_DATABASE_URL` (a live Postgres),
11 want a full ffmpeg. The single **error** is a genuine bug rather than a
missing dependency: `test_spec_round_trips_through_json` only serialises and
reparses a `RenderSpec`, but it takes the `media` fixture, which shells out to
ffmpeg to build sample files. It errors where it should skip.

Note the trap: the container ships a Playwright ffmpeg at
`/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux`. Putting it on `PATH` makes things
**worse** — it is a capture-only build, so `_ffmpeg_available()` returns true
and 11 tests turn from clean skips into errors.

### Browser harness

- Headless Chromium: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
- WebGL needs `--use-gl=swiftshader --enable-unsafe-swiftshader`
- Use `waitUntil:'domcontentloaded'` — **not** `networkidle`; `forge.start()`
  polls a dead port and networkidle never fires
- Kill stale preview servers before testing or you will test an old bundle.
  Kill by port, not `pkill -f 'vite preview'` — that pattern matches the
  shell's own command line and kills the session
- Measure the canvas from a **composited screenshot**, not `readPixels`. On a
  WebGL canvas without `preserveDrawingBuffer`, `readPixels` returns zeros
  after compositing; a suite written that way reports a black core that is
  rendering perfectly

## Update log

- **2026-09-15** — Full recheck. Found that the JavaScript suites this file was
  citing do not exist in the repository, and corrected the claim. Ran the
  committed forge suite for the first time. Fixed four defects in the 3D core:
  ripples scaled a unit torus so the stroke thickened ~3.7x as they expanded,
  `paintOrbiters` allocated four objects per frame against a comment claiming
  it allocated none, `resize()` ignored a change of device pixel ratio that the
  2D base class tracks, and a disposed renderer kept its WebGL context alive
  across core swaps.

- **2026-09-14** — Rebuilt the 3D reactor core against the 2D renderer as the
  reference. Corrected four defects found by rendering it and looking: stroke
  widths were 2x too thick (the pixel-to-world scale was measured against half
  the real panel size), two of the three containment rings were turned edge-on
  and collapsed into straight lines across the middle of the reactor, the
  reactor triangle pointed right instead of up, and the camera sat far enough
  back that the whole instrument rendered small inside its panel. Hardened
  teardown: `sweep()` replaces arc geometry as telemetry moves, so the
  ownership list no longer held what was live at destroy time.

- **2026-09-14** — Operator confirmed the stuck-boot symptom is cleared on their
  own Windows hardware. All three causes closed; the original defect is
  resolved and no longer carries an open verification.

- **2026-09-14** — Added this file. Verified build passes and the 3D chunk
  splits correctly. Found the PR stack (#3 → #2 → main) and that no CI is
  configured; both were previously unrecorded. Confirmed branch is current
  with its base and conflict-free.
