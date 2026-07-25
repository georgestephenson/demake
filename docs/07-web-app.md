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
product claim is a *ROM*, so the page builds one and plays it. **Live for `gb`.**

**Assembling needs no assembler installed** (doc 06), because the assembler is
ours: `packages/demotic/src/codegen/asm.ts` is TypeScript, so the page compiles
the game to SM83 machine code exactly as the CLI does. The art travels the same
way — the page hands the build raw SVG text and `@demake/core`'s own rasteriser
turns it into tiles, rather than the browser's SVG renderer, which would
antialias differently from Node's and put a different byte in the cartridge. The
bytes are identical to `demake build`'s — the parity contract this document
already asks of images, restated for games, and pinned by a Playwright spec that
builds `caves` on both sides and compares hashes — and the pane offers them as a
download.

**Playing it needs an emulator**, and it is ours: `@demake/dmg`, about 1200
lines of dependency-free TypeScript. Self-hosting a WASM core would have
satisfied the never-from-a-CDN rule, but not the reason behind it — a core we
cannot read is a dependency we cannot trust with the claim "this is what the
hardware does". Writing it was also the cheaper option, because the Demotic
conformance suite (doc 10) needed a headless Game Boy anyway, and one core now
serves both. It costs about 9 KB gzipped inside the already code-split game
chunk.

**The pane reports frames per tick**, and that is deliberate. The runtime does
not yet fit a game tick inside one Game Boy frame, so a game runs slower than
its nominal rate on real hardware; running the emulator fast enough to hide that
would be a lie to the person writing the game. The ROM plays at hardware speed
and the number says what that speed is.

A game the runtime cannot run — one with a level or a camera, today — gets a
message naming the feature instead of a cartridge that would play something
else.

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
