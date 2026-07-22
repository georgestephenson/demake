# 10 — Testing Strategy

The credo (goal G1): **"compliant" is proven on (emulated) hardware, not asserted.**
The flagship test takes one HD, color-rich source image through prep → gen → real
toolchain → real emulator → screenshot → pixel-perfect comparison, for every
supported console. Everything else supports that.

## Test pyramid

```
        E2E hardware-proof (ROM in emulator, screenshot compare)   ← per console, CI-gating
        Determinism matrix (Node × OS × browsers, byte-identical)
        Judge & tournament tests (metrics, glitch gates, anti-gaming, calibration)
        Golden-output tests (prep/gen fixtures, byte-exact)
        Property & invariant tests (compliance checker as oracle)
        Unit tests (color math, codecs, fitters, emitters)
```

## 1. Unit tests (Vitest)

Color-space round-trips (sRGB↔linear↔Oklab, lattice snapping, DAC models against
hand-computed vectors), PNG encode/decode round-trips, PRNG stability, per-stage
pipeline tests with tiny synthetic images (e.g. a 16×16 two-color image must survive
prep for every console unchanged where hardware allows). Codegen emitters tested
against hand-assembled expected bytes for minimal inputs (one-tile images).

## 2. Property & invariant tests (fast-check)

The **compliance checker** (`inspect`) is an independent implementation of the
ConsoleSpec rules — deliberately written naively (count colors per cell, check
lattice membership, check budgets) so it can act as an oracle:

- ∀ random images, options, consoles: `inspect(prep(img))` reports compliant.
- ∀ compliant images: `gen` exact-path detection fires and round-trips losslessly
  (decode(emitted tiles+palettes) == input pixels).
- prep is idempotent: `prep(prep(x)) == prep(x)` (same options).
- Determinism: same seed → same bytes; different seeds → valid outputs.
- Tournament invariants: the winner is never a disqualified candidate;
  `prep(strategy: winner)` reproduces the tournament's bytes exactly; pinning a
  stage flag only ever removes candidates (never changes a surviving candidate's
  output); worker-pool size/scheduling never changes the result.
- Auto-size: output dims ≤ console max, aspect preserved within 1 tile rounding,
  never upscaled.

## 3. Golden-output tests

Fixture corpus in `testdata/sources/`:

- `hd-many-colors.png` — the flagship: a purpose-made 3840×2160 image containing
  smooth gradients (all hues), skin tones, fine text, high-frequency texture,
  saturated flat regions, and near-black/near-white detail. (Purpose-made = we
  generate it from a checked-in script → no licensing issues, perfectly stable.)
- photographic samples (public domain), pixel-art samples at 1× and pre-upscaled 3×
  (exercises the pixel-art detector), transparency cases, extreme aspect ratios,
  1×1 and max-res edge cases.
- the predecessor portrait corpus (with permission — it's the user's own project):
  prep output must meet-or-beat the original tools' error metrics on it, and
  `--metric wrgb --quantizer mediancut` must reproduce the legacy pipeline class.

Every (fixture × Tier-1 console × canonical option set) has checked-in golden
outputs (PNG + manifest + asm hashes). Byte-exact comparison; re-baselining is a
reviewed, release-noted act (doc 09 §Stability). Perceptual-quality regression:
alongside byte goldens, we record fit-error metrics (Oklab MSE, SSIM vs source) and
fail if error worsens > ε without an explicit baseline bump — this catches
"different bytes AND worse" during algorithm work.

## 4. Judge & tournament tests

The doc-04 judge picks what users see, so it is tested like any other output-
critical component:

- **Metric unit tests**: each fidelity metric against analytic fixtures with known
  scores (identical images → perfect; inverted → floor; synthetic banding/noise/
  edge-loss images → move exactly the intended metric). The aesthetic metrics get
  targeted fixtures: a sprite with its specular highlights erased must crater
  highlight-retention while barely moving mean ΔE (the exact failure of naive
  quantizers this metric exists to catch); broken outlines and scrambled ramps
  likewise move only their own metric.
- **Glitch-gate tests**: hand-built defective outputs (torn attribute cell,
  duplicate palette slots, over-budget tilesets) must be disqualified with the
  right reason code — and never win by scoring well.
- **Anti-gaming fixtures**: adversarial candidate pairs where a single metric
  disagrees with human judgment (heavy dither that flatters mean ΔE but looks like
  static; oversmoothing that flatters SSIM but kills detail). The aggregate must
  rank them the way the human-calibration set says.
- **Calibration set**: a corpus of (source, candidate outputs, human ranking)
  triples collected in Phase 2, deliberately over-representing the hard aesthetic
  cases — cel-shaded characters, highlight-heavy sprites, subtle-shading portraits
  (the predecessor corpus), dark-outline art — alongside photos and flat-color art.
  Judge weights are fit to it once, frozen, and this suite pins the ranking forever
  after — any weight change must re-justify against it (and bumps a minor,
  doc 09 §Stability).
- **Tournament regression**: for the golden corpus, the *winning strategy id* per
  (fixture, console) is itself a golden value — an algorithm tweak that flips a
  winner is visible in review, not silent.

## 5. Determinism matrix

The same fixture conversions run on ubuntu/macos/windows Node, and in headless
Chromium/Firefox/WebKit via Playwright loading the actual web build. All six
environments must produce byte-identical PNGs and artifacts. Runs on every PR
(subset) and nightly (full corpus).

## 6. E2E hardware-proof tests (the flagship)

Per console: `hd-many-colors.png` → `prep` → `gen --format rom` → build in the
pinned toolchain container → boot in a headless emulator → capture the frame →
compare **pixel-perfect** against prediction.

### Pixel-perfect, defined precisely

The emulator frame is compared to `DAC(compliantImage)` — our indexed output pushed
through the same console DAC/color-curve model the emulator is configured to use.
Per console we pin: emulator version, color-correction mode (e.g. mGBA's GBA color
mode **off** / raw, so the mapping is the documented lattice expansion), cropping
(overscan), and warm-up frame count (boot + VRAM upload + 2 vsyncs, then capture).
The comparison is then **exact equality** of the visible region. Any nonzero diff
fails and dumps both images + a diff heatmap as CI artifacts. This makes the DAC
model itself a tested artifact: if our GBC curve mismatches SameBoy's, the test
says so.

### Harness per console (build tool + emulator, all pinned in `toolchains/`)

| Console | Build (in container) | Headless emulator + capture method |
|---|---|---|
| GB / GBC | RGBDS | **SameBoy** tester binary (built for automation: run-N-frames, dump BMP); cross-check with mGBA |
| GBA | devkitARM (or gcc-arm bare-metal) | **mGBA** headless (`mgba` CLI + Lua scripting: run frames, screenshot) |
| NDS | devkitARM + libnds + ndstool | **melonDS** (headless patches/CLI) or **DeSmuME** `--num-cores`-less autoframe advance; decision task in Phase 4 — both prototyped, best automation wins |
| NES | ca65 (NROM) | **Mesen 2** headless test-runner mode with Lua (runs on Linux, .NET) |
| SNES | ca65 65816 / wla-dx | **Mesen 2** headless (same runner) |
| Mega Drive | vasm m68k | **BlastEm** (headless mode) or Genesis Plus GX via libretro harness |
| SMS / GG / SG-1000 / Coleco | WLA-DX / z88dk | **Emulicious** (headless automation) or Mednafen; Gearsystem as fallback |
| PC Engine | PCEAS | **Mednafen** (pce_fast off, accuracy core) frame dump |
| Neo Geo | ngdevkit | ngdevkit's GnGeo fork or **FBNeo** via libretro harness |
| Atari 2600 | dasm | **Stella** (debugger CLI can script + `screenshot`) |
| Atari 7800 | dasm | **a7800** (MAME-derived, scriptable) or MAME with `-seconds_to_run`/`-snapname` |
| Atari 5200/8-bit | MADS | **Atari800** (`-headless` build, screenshot on exit) |
| Lynx | cc65 | **Mednafen** lynx core |
| WS / WSC / NGPC | Wonderful toolchain | **Mednafen** cores |
| Intellivision | as1600 | **jzIntv** (frame dump support) |
| Tier-3 mono/etc. | per platform | **MAME** as the universal fallback: `-video none -sound none -statename/-snapshot` scripting covers nearly every remaining system |

Where a first-choice emulator lacks clean headless capture, the fallback is the
**libretro harness**: a tiny purpose-built frontend (ours, ~300 lines C) that loads
a pinned core, runs N frames with null AV, and writes the framebuffer as PNG —
one automation surface for many systems. Prototyping this harness early (Phase 1)
de-risks the entire tier rollout.

All toolchains + emulators live in per-family Docker images
(`ghcr.io/<owner>/retroart-tc-<family>`), version-pinned by digest, built by a
scheduled workflow from `toolchains/` and used both by CI and by users' local
`--rom-builder docker` (doc 06) — CI and users share bit-identical builders.

### What E2E failures mean (triage guide, kept in the doc)

- Diff in palette values only → DAC model vs emulator color mode mismatch.
- Diff at tile boundaries → map/attribute emit bug.
- Shifted image → harness scroll/overscan init bug.
- Garbage → build or upload-order bug (VRAM writes during active display, etc.).

## 7. Surface tests

- CLI: `--help`/`--version`/exit codes/stdin-stdout/signals via integration harness
  (execa); man page lints (`mandoc -Tlint`); JSON outputs validated against the
  generated schema; `AGENTS.md` examples executed verbatim (doctest-style).
- Web: Playwright functional flows + the determinism suite + Lighthouse budget.
- Desktop: doc 08's parity E2E.
- Benchmarks: doc 04's performance targets tracked with a benchmark action;
  regression > 25% fails.

## Local ergonomics

`pnpm test` = unit+property+golden (no Docker, < 2 min). `pnpm test:e2e [console]`
= the emulator suite via Docker, filterable per console. All CI-failing artifacts
(diff heatmaps, ROMs, screenshots) are downloadable from the Actions run — a failed
E2E must be diagnosable without rebuilding locally.
