# J.A.R.V.I.S. — Progress

Living status file. Update it at the end of each session; don't rewrite the
history, append to it.

**Last updated:** 2026-09-14 · **Branch:** `c/nifty-clarke-qz3wv2` @ `1698a4e` · **PR:** [#3](https://github.com/MosporD/J.A.R.V.I.S/pull/3) (draft)

---

## Snapshot

| | |
|---|---|
| Build (`npm run build`) | ✅ passes — 42 modules, 1.07s |
| Main bundle | 101.98 kB / 36.42 kB gzip |
| Lazy 3D chunk | 540.77 kB / 135.45 kB gzip — correctly split out of main |
| Automated CI | ❌ none configured on this repo |
| Test suites | manual, headless Chromium — 83/83 passing |
| Diff vs base | 21 files, +1575 / −55, 9 commits |
| Merge conflicts | none — branch is current with its base |

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
- [ ] **Did the Windows CRLF fix actually clear the symptom on your machine?**
      Verified in this container only — never confirmed on your hardware.
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

- Headless Chromium via Playwright: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
- WebGL needs `--use-gl=swiftshader --enable-unsafe-swiftshader`
- Use `waitUntil:'domcontentloaded'` — **not** `networkidle`; `forge.start()`
  polls a dead port and networkidle never fires
- Kill stale preview servers before testing or you'll test an old bundle

| Suite | Result |
|---|---|
| boot | 14/14 |
| email | 11/11 |
| hotkeys | 10/10 |
| voice | 28/28 |
| cast | 20/20 |
| **total** | **83/83** |

---

## Update log

- **2026-09-14** — Added this file. Verified build passes and the 3D chunk
  splits correctly. Found the PR stack (#3 → #2 → main) and that no CI is
  configured; both were previously unrecorded. Confirmed branch is current
  with its base and conflict-free.
