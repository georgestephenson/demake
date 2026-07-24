---
"@demake/core": minor
---

The web app (Phase 3): the same engine, in the browser, with parity as a tested
contract.

`packages/web` is a Vite + Preact single-screen app that hosts `@demake/core` in
a Web Worker and never talks to a server — no upload, no accounts, no telemetry.
It follows doc 07: an input pane (drag-drop / picker / clipboard paste / a
bundled demo scene generated in code), a controls pane (console picker grouped
by tier with a per-console constraint summary, then the `demake prep` options in
CLI order with the advanced ones collapsed), and a preview pane (integer-zoom
result beside the source, optional DAC "hardware screen colors" and pixel-aspect
correction, the fitted palette strip, fit/tile-budget stats, and the tournament
scoreboard, whose rows double as a strategy picker). Exports cover PNG, the
manifest sidecar, asm, C and bin; the ROM button explains that browser assembly
isn't available and points at the CLI. Settings — never the image — serialize
into the URL hash, and a small service worker makes the page work offline.

Core gains two exports so the app cannot drift from the CLI: `buildManifest` and
`encodeManifest`, which previously lived inside the CLI's `prep` command. Both
edges now emit the identical sidecar bytes.

The parity claim is tested rather than asserted: a Playwright suite converts the
bundled demo image in Node through `@demake/core` and in the page through its
worker, then compares the exported PNGs **byte-for-byte** across Chromium,
Firefox and WebKit, for four cases spanning the mono path, a fixed-master
console, and a dithered 15-bit one. Alongside it run functional flows and a
gzipped-JS budget check (doc 07's 300 KB; the app currently ships ~43 KB).

CI adds a `test-browser` job, a Lighthouse budget job, and `pages.yml`, which
deploys `main` to GitHub Pages.
