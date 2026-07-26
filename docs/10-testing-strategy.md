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
hand-computed vectors), the in-house math kernels against reference values at full
precision (doc 02 §Floating-point discipline), PNG encode/decode round-trips,
**decoder fuzzing** (structured fuzz of malformed/truncated/hostile PNG/JPEG inputs
— decoders must error cleanly, never hang or corrupt; runs continuously via a
scheduled workflow with a seed corpus), PRNG stability, per-stage
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
- the predecessor portrait corpus (the author's own work, used with permission):
  prep output must meet-or-beat the original tools on it under the doc-04
  perceptual judge (not raw error alone — doc 04 §The objective), and
  `--metric wrgb --quantizer mediancut` must reproduce the legacy pipeline class.

Every (fixture × Tier-1 console × canonical option set) has checked-in golden
outputs (PNG + manifest + asm hashes). Byte-exact comparison; re-baselining is a
reviewed, release-noted act (doc 09 §Stability). Perceptual-quality regression:
alongside byte goldens, we record the doc-04 judge's aggregate and per-metric
scores (the perceived-equivalence ruler — raw Oklab MSE alone is explicitly
*not* the quality bar, doc 04 §The objective) and fail if a score worsens > ε
without an explicit baseline bump — this catches "different bytes AND worse"
during algorithm work. Judge-score regressions are confirmed by eye on the
`pnpm eval:prep` sheets before any baseline bump.

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
| GBA | GNU ARM binutils (`arm-none-eabi-as/ld/objcopy`) — bare-metal harness, no devkitARM | **mGBA** via the libretro harness (color correction off; compared in RGB555) |
| NDS | GNU ARM binutils + demake's own `.nds` cartridge packer (no ndstool) | **DeSmuME** via the libretro harness — *decided* (doc 13 standing decision): it direct-boots a cartridge with no BIOS/firmware images, so the whole loop builds from source; compared in RGB555 |
| NES | ca65 (NROM) | **Mesen 2** headless test-runner mode with Lua (runs on Linux, .NET) |
| SNES | WLA-DX (`wla-65816`) | **snes9x** via the libretro harness (compared in RGB565) |
| Mega Drive | vasm m68k | **BlastEm** (headless mode) or Genesis Plus GX via libretro harness |
| SMS / GG / SG-1000 / Coleco | WLA-DX / z88dk | **Emulicious** (headless automation) or Mednafen; Gearsystem as fallback |
| PC Engine | WLA-DX (`wla-huc6280`) | **beetle-pce-fast** (Mednafen's pce_fast) via the libretro harness (compared in RGB565) |
| Neo Geo | ngdevkit | ngdevkit's GnGeo fork or **FBNeo** via libretro harness |
| Atari 2600 | dasm | **Stella** (debugger CLI can script + `screenshot`) |
| Atari 7800 | dasm | **a7800** (MAME-derived, scriptable) or MAME with `-seconds_to_run`/`-snapname` |
| Atari 5200/8-bit | MADS | **Atari800** (`-headless` build, screenshot on exit) |
| Lynx | cc65 | **Mednafen** lynx core |
| WS / WSC | NASM (the V30MZ is 8086-compatible) | **beetle-wswan** (Mednafen's wswan) via the libretro harness (compared in RGB565, landscape forced by core option) |
| NGPC | Wonderful toolchain | **Mednafen** cores |
| Intellivision | as1600 | **jzIntv** (frame dump support) |
| Tier-3 mono/etc. | per platform | **MAME** as the universal fallback: `-video none -sound none -statename/-snapshot` scripting covers nearly every remaining system |

Where a first-choice emulator lacks clean headless capture, the fallback is the
**libretro harness**: a tiny purpose-built frontend (ours, ~300 lines C) that loads
a pinned core, runs N frames with null AV, and writes the framebuffer as PNG —
one automation surface for many systems. Prototyping this harness early (Phase 1)
de-risks the entire tier rollout.

All toolchains + emulators live in per-family Docker images
(`ghcr.io/<owner>/demake-tc-<family>`), version-pinned by digest, built by a
scheduled workflow from `toolchains/` and used both by CI and by users' local
`--rom-builder docker` (doc 06) — CI and users share bit-identical builders.

### What E2E failures mean (triage guide, kept in the doc)

- Diff in palette values only → DAC model vs emulator color mode mismatch.
- Diff at tile boundaries → map/attribute emit bug.
- Shifted image → harness scroll/overscan init bug.
- Garbage → build or upload-order bug (VRAM writes during active display, etc.).

## 6b. Demotic conformance (docs 14, 15)

Game state is small and exactly comparable, which buys a sharper oracle than the
image path can have.

**State traces.** A golden trace per (console, region) records raw 16.16 entity
state per tick for a fixed input tape — `packages/demotic/fixtures/pong.gb.trace`
is the first. Three things are diffed against it: the reference interpreter on
every commit; the browser preview in the web determinism suite (a whole game's
state, every tick — a far stronger parity check than any single image
comparison); and the console runtime, by reading its entity table out of work RAM
each tick. A port is proven by `diff`, not judgement. Values are raw integers
precisely so a one-bit disagreement cannot hide behind a rounded decimal.

**The backend's oracle is a unit test, not an E2E** — and that is a deliberate
departure from the image path. The generated code keeps its entities at constant
addresses, which the build reports, and `@demake/dmg` (our own Game Boy core,
~1200 lines, no dependencies) boots the compiled ROM and reads them, so
`packages/demotic/test/rom.test.ts` runs wherever `pnpm test` does: no
assembler, no emulator install, no self-skip. It builds a cartridge from *every*
game in the example library — levels, tiles and camera included — and asserts
the trace matches the interpreter tick for tick.

Art needs a test of its own, because art is not state: a build that silently
fell back to the placeholder block would pass every trace.
`packages/demotic/test/art.test.ts` therefore checks that the converted tiles
reach the ROM, that the OAM entries a running machine writes point at them, and
that more than two shades end up on screen. Writing our own core was the cheaper option twice over, because doc 07
also needs one in the browser and forbids fetching it from a CDN.

Framebuffer equality for games then rides the existing SameBoy E2E, testing only
rendering, because the logic has already been proven equal.

**`.test.dmt` suites.** Assertions about a game, written in the same expression
language as the game, run against *every* console. This is the only way to test
balance rather than mechanics: `expect abs(ball1.y - centery) < 15vh` means the
same thing on a 20×18 playfield and a 40×28 one, where an absolute assertion
would have to be written twice and would drift. The Pong suite runs in the unit
suite across all seven profiles, and is also runnable from the CLI (`demake
test`) and from the web app.

**Input-tape E2E.** The per-console emulator harness needs one addition: feed a
scripted button tape, and capture both the framebuffer at chosen ticks and the
runtime's entity table every tick. State equality catches all logic divergence;
the framebuffer comparison then tests only rendering. Same harness, same cores,
same capture path as §6.

**Demakefile properties.** Parsing and formatting are checked as algebra, which
is what makes the web app's settings a genuine view of the file rather than a
parallel system (doc 15):

- `fmt(fmt(x)) == fmt(x)` — formatting is idempotent.
- `emit(parse(x)) == fmt(x)` — the model round-trips through text losslessly.
- `emit(settings(parse(x))) == fmt(x)` — the UI round-trips.
- `trace(dmt, console, region)` is byte-identical **with and without** a
  Demakefile — the invariant that keeps gameplay out of the build file.

Plus a tabs-and-spaces matrix: the same Demakefile indented either way must parse
to the identical model, and mixing them within one file must fail naming both
offending lines.

## 6c. Audio conformance (docs 16, 17, 18)

The credo restated for sound: **"it sounds like the hardware" is proven, not
asserted** — and the proof is stronger than the image path's, because a register
schedule is an exact object and a framebuffer comparison is the best you can do
for pixels.

The equality is *not* "our WAV bytes equal the emulator's WAV bytes", and
pretending otherwise would be the audio version of claiming byte-identity across
browsers without deterministic math. Cores resample, filter, and model the analog
stage on their own terms. What is exact, and what actually carries the claim, is
split in three (doc 16 §The render contract):

**Level A — schedule equality (exact; runs wherever `pnpm test` runs).** Boot the
generated ROM in a core we own, log every write the chip receives with its driver
tick, and diff against the `ChipScript`. No tolerance, no metric. For the Game
Boy this needs `@demake/dmg` to grow an APU — which doc 07 needs anyway for the
page to make sound — after which the audio conformance suite is a plain unit test
with no toolchain and no emulator install, exactly as
`packages/demotic/test/rom.test.ts` is, and for the same reason: register writes,
like game state, are small exact objects. **This is where the guarantee comes
from.** A sound chip is a deterministic state machine; identical writes at
identical ticks are identical sound.

Level A runs twice, on the two cartridges that exist. `packages/audio/test/
rom.test.ts` does it for a cartridge whose only job is one schedule;
`packages/demotic/test/audio.test.ts` does it for a *game* — where the driver
runs on a timer while the game runs on VBlank, and an effect borrows a channel
from the music mid-track. The second is the harder claim and the same assertion:
with nothing preempting, the music's register stream is the schedule's, byte for
byte; while an effect plays, its own channel is its schedule's and the music's
channels are untouched.

**Level B — sample comparison against third-party cores (CI).** The libretro
harness already receives an audio callback and discards it; writing those samples
out is a small extension to `emu-harness/libretro/`. The core's audio is compared
against our chip model's render at the core's native rate with its own
post-processing disabled where the core allows. This level is **not bit-exact and
does not claim to be** — it is a pinned spectral-and-envelope distance per core,
plus **exact equality of transient onset ticks**, which is the half that would
catch a driver-timing bug. Where a core exposes scripted register access (Mesen
2's Lua interface), that console gets Level A too and Level B becomes a
cross-check.

**Level C — chip-model validation.** The models decide every comparison above, so
they are tested artifacts in the same sense the DAC models are: the community's
hardware-behaviour ROMs (`dmg_sound`, `cgb_sound`, the NES APU suites) run inside
our own cores and must pass; analytic unit tests check frequency formulas,
envelope step timing, LFSR tap sequences and the NES's non-linear mixing curve
against hand-computed vectors; and reference cores cross-check the result.

Test ROMs are fetched by a provisioner and never checked in, and the suite
self-skips without them — the discipline the emulator harnesses already use.

**Goldens.** Rendered WAVs are byte-compared, per doc 09 §Stability. This is
cheap, sharp, and only possible because there is exactly one renderer.

**Determinism.** The audio export joins the doc-10 §5 matrix: the same track
demade in Node and in Chromium/Firefox/WebKit must produce byte-identical audio.
This is the test that keeps the browser from quietly synthesizing anything of its
own (doc 07 §The audio sections).

**Judge tests**, mirroring §4: metric unit tests against analytic fixtures (a
transposed copy must score perfectly on interval preservation and poorly on
absolute pitch; a track with the backbeat removed must crater the onset metric
while barely moving spectral distance); glitch-gate tests for accumulating tempo
drift, loop-seam discontinuity and envelope clicks; anti-gaming fixtures where a
single metric disagrees with the ear; and a human-ranked listening corpus that
weights are fitted to once, then frozen.

**And the ears.** Doc 04's rule that quality changes need eyes on the eval sheets
applies with more force here, because audio metrics sit further from perception
than image metrics do. No judge weight moves without listening to the sheets
first (doc 17 §Evaluation).

## 7. Surface tests

- CLI: `--help`/`--version`/exit codes/stdin-stdout/signals via integration harness
  (execa); man page lints (`mandoc -Tlint`); JSON outputs validated against the
  generated schema; agent-guide examples executed verbatim (doctest-style);
  `CLAUDE.md` remains a pure `@AGENTS.md` import (doc 12).
- Web: Playwright functional flows + the determinism suite + Lighthouse budget.
- Desktop: doc 08's parity E2E.
- Benchmarks: doc 04's performance targets tracked with a benchmark action;
  regression > 25% fails.

## Local ergonomics

`pnpm test` = unit+property+golden (no Docker, < 2 min). `pnpm test:e2e [console]`
= the emulator suite via Docker, filterable per console. All CI-failing artifacts
(diff heatmaps, ROMs, screenshots) are downloadable from the Actions run — a failed
E2E must be diagnosable without rebuilding locally.
