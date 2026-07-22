# 07 — Web App (github.io)

The same engine, in the browser, hosted as a static site on GitHub Pages. No server,
no upload, no accounts, no telemetry. If GitHub Pages is up, the app works.

## Principles

- **Parity is a contract**: the web app calls the identical `@retroart/core` build
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
- `@retroart/core` in a Worker via Comlink-style RPC; transfers use
  `ArrayBuffer`s (zero-copy).
- Styling: hand-rolled CSS with light/dark via `prefers-color-scheme`. Pixel
  preview uses `image-rendering: pixelated` canvases.
- Static deploy: `packages/web` → `dist/` → GitHub Pages via Actions (doc 11).
  Base path configured for `https://georgestephenson.github.io/retro-game-art-maker/`
  (plus custom domain support if ever wanted).

## UX specification

Single screen, three panes:

1. **Input pane** — drag-and-drop / file-picker / paste-from-clipboard; shows
   source with dimensions and detected profile (art vs photo).
2. **Controls pane** — console picker (grouped by tier/era, with a one-line
   constraint summary per console: "GBC · 160×144 · 8 palettes × 4 colors"); then
   the doc-05 options: size (auto/preset/custom), mode, dither, scale kernel,
   effort, background. Advanced options collapsed by default. Live "equivalent
   command" line: `retroart prep img.png -c gbc --dither bayer4 …` with a copy
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
- Budget: < 300 KB JS gzipped before WASM codecs (lazy-loaded per input format);
  Lighthouse ≥ 95 across the board, checked in CI.
- Browser matrix: last 2 versions of Chrome/Firefox/Safari/Edge, tested via
  Playwright in CI (functional + determinism suites).
