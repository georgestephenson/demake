# 13 — Roadmap

Phases are sequential but internally parallelizable; each has explicit acceptance
criteria ("done means"). Consoles ride the tier schedule from doc 03. Per the
product direction, scope is driven by completeness and quality, not effort budgets —
phases order the work; they don't trim it.

## Phase 0 — Foundations

Repo scaffolding: pnpm workspaces, strict TS config, eslint/prettier + custom rules,
Vitest, CI skeleton (lint + unit on 3 OSes), changesets, README/CLAUDE.md/
CONTRIBUTING/SECURITY stubs, name check + npm scope reservation (`demake`,
`@demake/*`).

**Done means**: green CI on a hello-world core function imported by a stub CLI that
passes `--help`/`--version`/exit-code tests; npm names secured.

## Phase 1 — Engine spine + first console (GBC)

- Image layer: PNG codec (ours), WASM JPEG/WebP/GIF/BMP decode, RGBA pipeline,
  color spaces (linear/Oklab), seeded PRNG, DAC models (CGB curve first).
- ConsoleSpec schema + `gbc` spec (+ `dmg` — nearly free and exercises mono path).
- Pipeline stages 0–7 for tiled layouts (doc 04), generic fitter with alternating
  refinement + restarts; compliance checker (`inspect`) as independent oracle.
- CLI: `prep`, `inspect`, `consoles` per doc 05 (flags, exit codes, stdin/stdout,
  `--json`); `cli-spec` generation pipeline incl. man pages.
- **De-risking spikes** (start immediately, parallel): (a) the libretro capture
  harness prototype; (b) SameBoy/Mesen2 headless capture proof; (c) Node SEA binary
  proof. These decide doc-10 tooling while the engine is built.
- Hardware-spec verification pass for Tier 1 specs (primary-source citations).

**Done means**: predecessor portrait corpus preps at meet-or-beat quality vs the
original tool (metric comparison checked in as a test); property suite green;
determinism (Node 3-OS) green.

## Phase 2 — gen + the proof loop (GBC first, then Tier 1 breadth)

- Codegen framework + `gb` family backend (bin/asm/c), exact-path detector,
  manifest sidecar; `gen` CLI with implicit-prep.
- `rom` format: GB harness ROM, RGBDS toolchain container, SameBoy headless capture,
  **first pixel-perfect E2E test green** — the moment the credo is real.
- **Tournament + judge** (doc 04): candidate portfolio framework over the Phase-1
  stage library, worker-pool parallel execution with stage-DAG memoization, the
  multi-metric perceptual judge (validity/glitch gates, relational + absolute
  metric groups per doc 04 §The objective, aggregation), `--strategy` surface,
  human-calibration set collection and weight freeze.
- **Perceived-equivalence judge increment** (doc 04 §The objective — the
  post-eval-battery direction change): grade-aligned ΔE (isotonic monotone L +
  bounded chroma gain + bounded hue drift), asymmetric separation retention,
  asymmetric local contrast, ramp-ordering monotonicity, naturalness bounds,
  palette-pressure-scaled weights; graded (`expand`/`punchy`) candidates in the
  portfolio; separation-aware fitting term. Guardrails: round-trip idempotence
  on authored art stays a hard test, absolute palette recall keeps weight.
- Quality bench: fixture corpus + error-metric tracking + prior-art comparison
  (doc 04); `--effort max` annealing pass; tile-budget merge stage.
- Roll Tier 1 breadth, one console at a time, each = spec + backend + harness +
  toolchain image + E2E green: **NES → SMS → MD → SNES → GBA → NDS**
  (ordered easy→hard on codegen/emulator automation; NES early because its 16×16
  attribute cells and fixed master palette stress the fitter design).

**Done means**: `hd-many-colors.png` passes the full prep→gen→ROM→emulator→
pixel-perfect loop for all eight Tier 1 consoles in CI.

**Status: complete.** All eight Tier 1 consoles (DMG, GBC, NES, SNES, MD, SMS,
GBA, NDS) run the whole loop, each against the shared extensive image battery
(`packages/cli/test/_emu-battery.ts`) rather than a single fixture: SameBoy for
the GB family, and the one generic libretro harness for the rest (fceumm,
genesis-plus-gx, snes9x, mGBA, DeSmuME). SG-1000 came along early with the
TMS9918 row-pair path; the Game Gear rides the SMS family. Every toolchain is a
pinned source build or a stock distro package provisioned by `pnpm toolchains` —
no Docker anywhere in the loop.

## Phase 3 — Web app

Vite+Preact app per doc 07: worker-hosted core, full option UI, previews with
DAC/PAR rendering, exports (PNG/manifest/asm/c/bin; in-browser ROM for GB + NES),
equivalent-command display, PWA, Pages deploy, Playwright + browser-determinism CI.

**Done means**: github.io live; browser output byte-identical to CLI across
Chromium/Firefox/WebKit in CI; Lighthouse ≥ 95.

## Phase 4 — Desktop app + distribution

Tauri app per doc 08 (sidecar CLI, shared frontend, batch mode); Node SEA binaries;
`release.yml` end-to-end (npm provenance, signed installers, SLSA attestations,
auto-update); library docs + Typedoc site; generated agent guide + `help --agents`.

**Done means**: a tagged release automatically ships npm + 5 binaries + 3 desktop
installers + Pages + docs, all from one tag; desktop parity E2E green.

## Phase 5 — Tier 2 rollout

PCE, Game Gear, TMS9918 pair (SG-1000/Coleco + the row-pair fitter), Neo Geo,
Atari 7800, WS/WSC, NGPC, Lynx — same per-console definition-of-done as Phase 2.
Plus: per-scanline palette scheduling (Lynx/framebuffer enhancement), mode-selection
optimizer polish (SNES/GBA/ANTIC).

**Done means**: all Tier 2 consoles E2E-green in nightly CI; docs/README support
table auto-updated.

## Phase 6 — 1.0

Freeze CLI/API surfaces; full-corpus nightly green two weeks running; docs complete
(man pages, site, README demo GIF); Homebrew/Scoop; `v1.0.0`.

**Done means**: every doc-01 success criterion checked off in the release PR.

## Phase 7+ — Post-1.0

- **Tier 3 long tail**: 2600 kernels, Atari 8-bit/5200, Intellivision, Virtual Boy,
  Pokémon Mini, and the remainder — each lands with its harness or ships prep-only
  with a documented "codegen pending toolchain validation" status.
- In-browser ROM assembly for more families; WASM-accelerated hot kernels if
  profiling asks; palette-cycling & per-scanline tricks as opt-in "expert" flags;
  sprite/animation mode (the reserved schema slot); home-computer specs if demand
  appears; tiny fixed-weight learned perceptual metric as a judge input
  (doc 04 §Aesthetics — admissible only if byte-deterministic and browser-sized).
- **Audio demake (new domain, exploratory)**: extend beyond images — convert
  modern music and sound effects into hardware-compliant chip audio and playable
  driver data for the same consoles (GB pulse/wave/noise, NES 2A03, SNES SPC700
  BRR samples, MD YM2612 FM patches). Same shape as the image pipeline:
  constrain → fit → emit → prove in an emulator, with audio-capture E2E standing
  in for pixel-perfect. Starts as a spike plus its own design doc before any
  tier commitment.
- **3D asset demake (new domain, exploratory)**: apply the same treatment to the
  32/64-bit 3D era — take a common modern 3D asset and emit PS1/N64/Saturn-
  compatible ones: polygon budgets and retopology, texture quantization through
  the existing image pipeline (palettes/CLUTs, N64's 4 KB TMEM tiling), and
  per-platform geometry quirks (PS1 fixed-point vertices and affine texturing,
  Saturn quads). Doc 03's generation cutoff stands for 2D image conversion;
  these platforms enter scope only for this separate 3D domain.

## Standing decision log

Decisions this plan defers, each becoming an ADR when made:
~~DS emulator choice (melonDS vs DeSmuME automation)~~ — **decided in Phase 2:
DeSmuME via the libretro harness.** It direct-boots a `.nds` with no BIOS or
firmware images, so the DS loop builds from source on a bare machine like every
other console; melonDS's BIOS/firmware requirement would have made the E2E
unrunnable in CI without shipping copyrighted files. · Node SEA vs
Bun compile (Phase 1 spike) · final name confirmation (Phase 0) · MD 32X/Sega CD
"extended spec" inclusion (post-1.0) · Oklab L-weight and judge metric-weight
calibration values (Phase 2, frozen thereafter) · initial candidate-portfolio
composition per console class (Phase 2, revisited per tier rollout).
