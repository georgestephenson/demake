# 07 — Web App (github.io)

The same engine, in the browser, hosted as a static site on GitHub Pages. No server,
no upload, no accounts, no telemetry. If GitHub Pages is up, the app works.

## Principles

- **Parity is a contract**: the web app calls the identical `@demake/core` build
  the CLI uses; CI verifies byte-identical PNG output between Node and browser for
  the fixture corpus (doc 10 §Determinism).
- **Everything client-side**: image decode (WASM codecs), pipeline, PNG/asm/c
  generation, and (where implemented, doc 06) in-browser ROM assembly all run in a
  Web Worker. The page never phones home.
- **The UI mirrors the CLI's mental model** — same option names, and it *shows you
  the equivalent CLI command* for the current settings (great for humans graduating
  to scripts, great for agents reading screenshots, great for bug reports).

## Stack

- Vite + TypeScript + Preact (small, fast, no framework lock-in for a one-page
  tool). State in a single store; no router beyond hash-permalinks.
- `@demake/core` in a Worker via Comlink-style RPC; transfers use
  `ArrayBuffer`s (zero-copy).
- Styling: hand-rolled CSS with light/dark via `prefers-color-scheme`. Pixel
  preview uses `image-rendering: pixelated` canvases.
- Static deploy: `packages/web` → `dist/` → GitHub Pages via Actions (doc 11).
  Base path configured for `https://georgestephenson.github.io/demake/`
  (plus custom domain support if ever wanted).

## Sections

The site is one shell over four demakers, because demake demakes game assets and
images are only one kind (doc 01 §Scope):

| Section | What it does | State |
|---|---|---|
| **demotic game demaker** | write a `.dmt`, play it on any console, run its `.test.dmt` suite | live |
| **art demaker** | the image pipeline described below | live |
| **music demaker** | tracks → chip music | coming soon |
| **sound demaker** | effects → chip sound | coming soon |

The route lives in the hash as `#section=<id>`, and the **art demaker is the
unmarked default** — so every option permalink shared before the site grew
sections still opens exactly what it used to.

### The Demotic section

Two panes. **Play** carries the console picker, the canvas, and a *console
pixels* toggle that switches between the art as authored (SVG, any resolution)
and the same state on the target's real 8×8 grid with over-limit scanlines shaded
red — the product thesis in one control. **Game** is the editable source with
per-line diagnostics, and a *Run tests* button that runs the `.test.dmt` suite
against every console at once and reports the tally.

The simulator runs on the main thread, not in the engine worker: a tick is a few
hundred integer operations on a handful of entities, so the round trip would cost
more than the work. Art conversion still goes to the worker.

**The section is code-split.** It carries the whole game language — compiler,
interpreter, test runner — and someone who came to convert an image should not
download any of it, so it loads on first navigation and the art demaker's initial
payload is what it was before the site grew sections.

**On-screen controls** appear where the primary pointer is coarse. They bind the
*abstract* button set (`left right up down a b start`), never a particular
console's controller — identical for every console and every game, because that
set is the only thing a `.dmt` file can bind to. Pointer events rather than touch
events, so a stylus and a mouse work too, and every button releases on
`pointerleave` and `pointercancel` as well as `pointerup`: sliding a thumb off
the d-pad must not leave a paddle running forever.

A syntax error never blanks the preview — the parser recovers per line, and the
page keeps running the last version that compiled.

### Playing the real ROM in the page

The preview runs the reference interpreter, which is the specification — but the
product claim is a *ROM*, so the page must build one and play it. Two steps:

**Assembling needs no assembler** (doc 06): the browser patches compiled tables
into a CI-assembled runtime blob and fixes the checksums.

**Playing it needs an emulator** — a WASM core, loaded lazily and **self-hosted**,
never from a CDN, because "never phones home" is not negotiable and a CDN script
would also break the offline PWA guarantee. EmulatorJS is the obvious candidate
since it covers `gb`/`nes`/`sms`/`md` behind one API; it would be vendored and
served from our own origin.

Both steps wait on there being a runtime at all (doc 13, milestone D3). Until
then the section previews and exports source, and says so rather than shipping a
button that does nothing.

## UX specification

The art demaker: single screen, three panes:

1. **Input pane** — drag-and-drop / file-picker / paste-from-clipboard; shows
   source with dimensions and detected profile (art vs photo).
2. **Controls pane** — console picker (grouped by tier/era, with a one-line
   constraint summary per console: "GBC · 160×144 · 8 palettes × 4 colors"); then
   the doc-05 options: size (auto/preset/custom), mode, dither, scale kernel,
   effort, background. Advanced options collapsed by default. Live "equivalent
   command" line: `demake prep img.png -c gbc --dither bayer4 …` with a copy
   button.
3. **Preview pane** — side-by-side or A/B-slider source vs result, at integer zoom
   with optional CRT-ish PAR-corrected view (uses the spec's `pixelAspect` and DAC
   model); a palette strip showing fitted sub-palettes; fit-error and tile-budget
   stats from the manifest; and the tournament scoreboard — which strategy won,
   per-candidate scores, with click-to-preview of any candidate's output (this
   doubles as a strategy picker: choosing one sets `--strategy <name>` in the
   equivalent-command line).

Conversion re-runs debounced on option changes (fast path: cached analysis +
geometry; the fitter reruns). `--effort max` is behind an explicit "High effort"
toggle with a progress bar (worker reports stage progress).

**Export buttons**: PNG · manifest JSON · asm · C · bin · ROM (family-dependent,
disabled with a tooltip linking to the CLI when browser assembly isn't available
for that console).

**Permalinks**: options (not the image) serialize into the URL hash so settings are
shareable; "Load demo image" ships a bundled test image so the page demos itself.

## Quality bar

- Works fully offline after first load (PWA manifest + service worker, cache-first).
- Accessible: keyboard operable, labeled controls, honors reduced-motion.
  Contrast is always set with an explicit colour, **never with opacity** — a
  translucent foreground composites against whatever is behind it, which is both
  a measured contrast failure and genuinely harder to read.
- Budget: < 300 KB JS gzipped before WASM codecs (lazy-loaded per input format);
  Lighthouse ≥ 95 across the board, checked in CI.
- Browser matrix: last 2 versions of Chrome/Firefox/Safari/Edge, tested via
  Playwright in CI (functional + determinism suites).
