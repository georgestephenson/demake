# AGENTS.md — working in this repository

Guidance for coding agents (and humans) contributing to demake.
This file is the canonical project-memory file; `CLAUDE.md` is a one-line import
shim so Claude Code reads the same instructions. Keep all guidance here — never
add content to `CLAUDE.md` directly.

## What this is

A tool that **demakes modern game assets** — art, and whole games — into
something 8/16-bit-era consoles and handhelds up to the Nintendo DS could
actually run. Four demakers, sharing one engine and one proof (a real ROM, in a
real emulator, compared pixel for pixel):

| Demaker               | Docs         | State                                                           |
| --------------------- | ------------ | --------------------------------------------------------------- |
| art (images)          | 03–06        | working, eight Tier 1 consoles proven                           |
| game (Demotic `.dmt`) | 14, 15       | language, interpreter, tests, preview working; runtimes to come |
| music                 | 13 §Phase 7+ | planned                                                         |
| sound                 | 13 §Phase 7+ | planned                                                         |

Every domain has the same shape, which is why they share a repo: **constrain →
fit → emit → prove it on emulated hardware**. Each reuses the layer below — a
game's sprites are demade by the image pipeline, its ROM assembled by the same
toolchain edge. The full
design lives in [`docs/`](docs/README.md); the milestone plan is
[`docs/13-roadmap.md`](docs/13-roadmap.md). **Current status: Phase 2 complete;
Phase 3 (web app) shipped** — the Phase-1 engine spine is live (the
deterministic image layer: our PNG codec, color spaces, DAC models, seeded PRNG,
math kernels; the `ConsoleSpec` schema; the tiled-and-mono conversion pipeline
with tournament + judge; the `inspect` compliance oracle). Phase 2 landed the
full proof loop for **all eight Tier 1 consoles**:

- **`prep`/`inspect` for 21 consoles** — every RGB-lattice and mono raster
  platform in doc 03 (GBC/DMG, NES, SNES, MD, SMS/GG, GBA, NDS, PCE, Neo Geo,
  WS/WSC, NGP/NGPC, VB, Pokémon Mini, Supervision, Game.com, Mega Duck) plus the
  SG-1000, through the one generic tiled fitter + mono path + the TMS9918
  Graphics II per-row two-color path (`pipeline/fit-tms.ts`). NES added
  `fixed-master` color, 16×16 attribute cells, and the shared-backdrop constraint.
- **Codegen** (`bin`/`asm`/`c`) for the `gb`, `nes`, `snes`, `sms`, `md`,
  `sg1000`, `gba`, and `nds` families, reached via an exact-path detector, a
  manifest sidecar, or implicit `prep`.
- **`--format rom`** builds bootable ROMs for GB (RGBDS), NES (cc65 NROM), SMS +
  GG + SG-1000 (WLA-DX / Z80), SNES (WLA-DX / 65816, LoROM), MD/Genesis (GNU m68k
  binutils), and GBA + NDS (GNU ARM binutils). The z80/6502/65816 assemblers are
  pinned source builds; the m68k and ARM binutils are stock distro packages (apt,
  main archive) since well-tested ones ship there — all via `pnpm toolchains`, no
  Docker, and no devkitARM/ndstool (demake packs the GBA and NDS cartridge
  headers itself).
- **Pixel-perfect emulator E2E** for every Tier 1 console — GB/GBC (SameBoy) and
  NES + SMS + GG + MD + SG-1000 + SNES + GBA + NDS (libretro cores via one
  generic `emu-harness/libretro/` runner) — all marching through the same shared
  extensive image battery (`packages/cli/test/_emu-battery.ts`).

Still to come: the remaining Tier 2/3 consoles (each = a codegen backend, a ROM
harness + toolchain, and a libretro core + DAC calibration), and the remaining
framebuffer/scanline layout paths (Lynx, GBA/NDS bitmap modes, 2600/7800).

## Layout map

```
packages/core/       @demake/core — the engine (zero platform deps; ESM; ships types)
  src/math/          deterministic kernels (exp/log/pow/cbrt/sin) + PCG32 PRNG
  src/color/         sRGB/linear/Oklab, hardware-lattice snapping, color parsing
  src/image/         PNG codec (inflate/deflate/decode/encode), DAC models, decode dispatch
  src/consoles/      ConsoleSpec schema + one declarative spec per console (21 of them)
  src/pipeline/      stages 0–7, the tiled fitter, mono + TMS row-pair paths, tournament
  src/codegen/       gen: per-family backends (gb, nes, snes, sms, md, sg1000, gba, nds), detector
  src/inspect/       compliance oracle (inspect) + fidelity judge
packages/cli-spec/   @demake/cli-spec — single source of truth: spec → parser, help, man
packages/cli/        demake — thin CLI over core; re-exports core for scripting
  src/rom/           edge: assemble `--format rom` per family (RGBDS / cc65 / WLA-DX / m68k / ARM)
  man/               generated roff man pages (never hand-edited)
rom-harness/{gb,nes,snes,sms,md,sg1000,gba,nds}/  the display programs `gen --format rom` assembles
emu-harness/gb/      SameBoy headless capturer for the GB pixel-perfect E2E (doc 10)
emu-harness/libretro/  generic retrorun frontend — one capturer for every libretro core
tools/toolchains/    provisioners (cached): RGBDS, cc65, WLA-DX, SameBoy source builds;
                     GNU m68k + arm-none-eabi binutils (apt); libretro cores
                     (fceumm, genesis-plus-gx, snes9x, mgba, desmume)
packages/demotic/    @demake/demotic — Demotic, the `.dmt` game language (docs 14, 15)
  src/lang/          lex → parse → flat statement AST (one statement per line, no nesting)
  src/compile.ts     AST + console profile → resolved Program tables (constants folded)
  src/sim.ts         the reference interpreter — the semantic definition of the language
  src/testing/       .test.dmt: assertions run against every console at once
  src/trace.ts       state traces: the cross-implementation conformance oracle
  demo/              terminal runner (play.mjs) and test runner (test.mjs)
tools/eslint-rules/  custom ESLint rules: platform-purity + determinism
tools/ci/            CI guards: E2E prerequisites, web JS budget
docs/                the design plan; source of truth for decisions
```

Packages not yet created (desktop, testdata) arrive in later phases per doc 02.

## Golden commands

```sh
pnpm install       # install workspace deps (Node >= 20, pnpm pinned via packageManager)
pnpm build         # typecheck + build all packages (tsc project references)
pnpm test          # Vitest unit suite
pnpm lint          # ESLint (incl. custom core rules) + Prettier check
pnpm lint:fix      # autofix ESLint + Prettier
pnpm changeset     # add a changeset for a user-visible change
pnpm cli -- --help # run the built CLI from source (build first)
pnpm gen:man       # regenerate man pages from cli-spec (build first; CI checks staleness)
pnpm eval:prep     # prep quality battery: scoreboard + side-by-side sheets (build first)
pnpm play          # Demotic: play the Pong fixture in a terminal (build first)
pnpm test:dmt      # Demotic: run the .test.dmt suite on every console (build first)
pnpm gen:demotic-docs  # regenerate the language reference from the registry (build first)
pnpm dev:web       # run the web app against the workspace core (build core first)
pnpm build:web     # typecheck + bundle the web app into packages/web/dist
pnpm test:browser  # Playwright: web functional + browser-vs-Node determinism
pnpm check:web-budget  # assert the app's gzipped JS stays under the doc-07 budget
pnpm toolchains    # provision every assembler `gen --format rom` needs (cached)
pnpm emulator      # provision the SameBoy capturer + libretro cores for the E2E
```

## Iron rules

- **`core` stays platform-pure**: no `fs`/`Buffer`/DOM, no Node built-ins.
  I/O lives at the edges (CLI/web/desktop). Lint enforces (doc 02).
- **`core` stays deterministic**: no wall clock (`Date.now`, `new Date`), no
  `Math.random`, and no `Math.*` transcendentals — use the in-house math kernels
  (`packages/core/src/math/kernels.ts`). Lint enforces (doc 02 §Determinism).
- **Output-byte changes** require re-baselined goldens **+ a `minor` changeset +
  a release-note line, all in the same PR** (doc 09 §Stability). Patch releases
  never change output bytes.
- **`packages/cli-spec` is the only place flags are defined** (doc 05); the
  parser, `--help`, and man pages are generated from it. Man pages are never
  hand-edited — run `pnpm gen:man` and a test enforces they match the spec.
- **Language changes are the maintainer's call, not the agent's.** Adding,
  removing or altering a Demotic statement, property, unit, builtin, trigger or
  diagnostic — anything in `packages/demotic/src/lang/spec.ts` — needs the
  maintainer to agree the design _before_ it is implemented. Propose options and
  their trade-offs and wait. Finding a limitation while writing an example is
  expected and welcome; quietly fixing it by growing the language is not. Bug
  fixes that restore documented behaviour are not language changes.
- **`packages/demotic/src/lang/spec.ts` is the only place the language surface is
  defined**, the way `packages/cli-spec` is for the CLI (doc 05). The parser, the
  compiler, the diagnostics and the reference documentation are all generated
  from or checked against it; a test fails if the docs go stale. Never describe a
  language feature in prose that is not in the registry.
- **Demotic describes the game; the Demakefile describes the build** (docs 14,
  15). A `.dmt` file must never name a console, a palette, or a pixel, and a
  Demakefile must never change how the game plays. The operational test is a CI
  property: `demake trace` for a given (console, region) is byte-identical with
  and without a Demakefile. Region is a _profile selector_, not an override.
- **Demotic simulates constrained and renders unconstrained** (doc 14): state is
  16.16 fixed point on a fixed logical tick, identical in the preview and (later)
  on hardware; only rendering is free. Never "improve" the simulator with floats,
  a variable timestep, or host RNG — that turns the preview from a specification
  into a second, disagreeing implementation. Golden traces
  (`packages/demotic/fixtures/*.trace`) are output bytes under the rule above.
- **`CLAUDE.md` stays a pure `@AGENTS.md` import** (CI-checked, doc 12).
- **Commands named in this file must exist as `package.json` scripts** (CI
  staleness check, doc 12) — update both together.

## Working on Demotic

- **Two unit systems, and the choice is semantic** (doc 14 §3). `1 cell` is
  absolute; `15vw` is 15% of the playfield. Absolute where a thing _is what it
  is_ everywhere (a one-tile ball); relative where it must stay _balanced_ (a
  paddle covering a sixth of the wall, a rally taking the same seconds). Sizes
  quantise to whole cells; speeds and positions do not. `vmin` for anything that
  must stay square — the consoles do not share an aspect ratio.
- **Level rules are continuous, so prefer proportional control to on/off.**
  `when always (…) as clamp(error / gain, -1, 1)` eases in and lands on target;
  on/off steering overshoots by a tick every tick and buzzes, and a dead zone
  wide enough to stop that makes it lurch instead. Both failure modes show up as
  stop/start events, which `sim.test.ts` bounds.
- **Hardware traps are compile errors, not emulator surprises** (doc 14
  §Diagnostics): sprite budgets, tunnelling, sub-tick speeds, offscreen starts,
  aspect mismatch, size rounding. Adding a new class of known trap means adding a
  diagnostic, not a doc note.
- **`hits` fires once per contact; `touches` fires every tick of it.** Bounces
  want the first, resting contact wants the second — a platformer that lands with
  `hits` accumulates gravity into `ydirection` while standing still, and looks
  fine until the next jump. `reaches` is a _crossing_ detector so it works on
  counters that fall as well as rise.
- **`visible 0` is inert**: not drawn, not collided with, not moved. That is why
  there is no `destroy`.
- **New language features come from the example library, not from theory**
  (`packages/demotic/fixtures/games/`). Each example is there for something the
  others do not exercise; `touches`, the `reaches` crossing rule and `visible`'s
  collision meaning were all found by writing one.
- **`.test.dmt` suites run on every console.** That is what makes a _balance_
  regression visible; a mechanical one would show up anywhere. Write assertions
  in the relative vocabulary or they will only be true on one machine.

## How to add a console

Two files plus fixtures (doc 02 §Extensibility):

1. `packages/core/src/consoles/<id>.ts` — a declarative `ConsoleSpec`, then
   register it in `consoles/registry.ts`. This alone makes the console work for
   `prep`/`inspect` today (the generic tiled fitter or the mono path consumes
   the spec). Cite primary hardware sources in `docs.sources` (doc 03).
2. `packages/core/src/codegen/<family>.ts` — native data + display source, then
   register it in `codegen/registry.ts` (Phase 2). The `gb` family is the model.
3. `rom-harness/<family>/` (display program), `emu-harness/<family>/` (headless
   capturer), and a pinned source-build provisioner in `tools/toolchains/`
   (Docker not required — see the RGBDS/SameBoy scripts) — the console is only
   "supported" when its pixel-perfect emulator E2E passes (Phase 2, doc 10).

## Testing truths

- `pnpm test` runs the Vitest unit suite locally with no Docker (< 2 min target).
- The ROM-build E2E (`packages/cli/test/rom.e2e.test.ts`) assembles a real
  `.gb`/`.gbc` through RGBDS; it self-skips when the toolchain is absent, so run
  `pnpm toolchains` first to exercise it. RGBDS is provisioned by a source build
  (`tools/toolchains/install-rgbds.sh`), and web sessions get it automatically
  via the `.claude/` SessionStart hook.
- The pixel-perfect emulator E2E (`packages/cli/test/emu.e2e.test.ts`, doc 10)
  boots the ROM in SameBoy and asserts the framebuffer matches the DAC reference
  byte-for-byte; it self-skips without the capturer, so run `pnpm emulator`
  (which needs `pnpm toolchains` first) to exercise it. The capturer is built
  from `emu-harness/gb/capture.c` against `libsameboy`; web sessions get it via
  the `.claude/` SessionStart hook.
- CLI tests exercise both the pure `run()` function and the spawned built binary;
  the binary test skips when `dist` is absent, so run `pnpm build` first to
  include it (CI always does).
- The web suite is Playwright, not Vitest: `pnpm test:browser` builds the app,
  serves the _built_ bundle, and runs both specs in Chromium + Firefox + WebKit.
  `packages/web/test/e2e/determinism.spec.ts` is the doc-07 parity contract —
  it converts the bundled demo image in Node through `@demake/core` and in the
  page through its worker, then compares the exported PNGs byte-for-byte. Narrow
  the browsers with `DEMAKE_BROWSERS=chromium`, and point at a browser already on
  the machine with `DEMAKE_CHROMIUM=/path/to/chrome` (managed containers ship
  one; CI runs `playwright install`).

## Gotchas

- **The prep objective is perceived equivalence, not per-pixel closeness**
  (doc 04 §The objective — a deliberate direction change): under palette
  pressure, keeping regions _distinct_ and exaggerating tone/chroma the way
  period artists did beats minimizing raw ΔE; a bounded coherent grade is
  nearly free to the judge. Never "improve" the judge back toward pure
  per-pixel ΔE, and keep round-trip idempotence on authored art as the
  zero-pressure guardrail.
- NES attribute cells are 16×16, not 8×8 — a load-bearing detail for the fitter.
- **`prep` works in the console's _author space_**: on the GBC the `cgb` DAC
  model is an LCD _panel filter_, so fitting/judging/storage use raw RGB555
  expansion (matching the E2E — SameBoy runs with color correction disabled);
  the panel sim is opt-in via `--dac-colors`. Consoles whose DAC model is the
  hardware's own output (NES NTSC, MD VDP, mono ramps) author in display
  colors. `inspect`/`gen` accept a compliant PNG in either encoding (doc 04).
- **Prep quality changes need eyes, not just numbers**: run `pnpm eval:prep`
  and look at the side-by-side sheets in `tools/prep-eval/out/`; the behavioral
  floors live in `packages/core/test/quality.test.ts`. Drop extra real-world
  sources into `tools/prep-eval/local/` (gitignored — never commit assets that
  aren't public domain).
- DAC models are tested artifacts: they decide pixel-perfect emulator comparisons.
  The MD `md-vdp` model reproduces genesis-plus-gx's Mode-5 normal-intensity
  color exactly (its `MAKE_PIXEL(2·code, …)` in 5:6:5); the SMS/GG cores render
  16-bit, so their E2E compares in RGB565, not 8-bit.
- MD tile 0 is reserved blank/transparent: color index 0 is transparent and
  reveals the second scroll plane, so the `md` codegen shifts real tiles to
  index 1 and the harness leaves plane B pointing at the (blank) tile 0 → the
  backdrop shows through, not stray patterns. The SMS/GG harness terminates the
  sprite list (Y=$D0) for the analogous reason.
- The `sms`-family ROM builder offsets the image into the name table by the VDP
  crop margin so the Game Gear's 160×144 window lands on the art; the MD harness
  addresses its data with absolute (not PC-relative) loads because the tile blob
  can exceed the 68000's ±32 KiB PC-relative range.
- **The SNES scrolls by one line**: the PPU renders screen scanline N from BG
  line `BGnVOFS + N + 1`, so the harness sets `BG1VOFS = -1` ($3FF). With zero
  there the whole image is one pixel low and every E2E case fails by exactly a
  row — the "shifted image" entry in doc 10's triage guide, in the flesh.
- mGBA (GBA) and DeSmuME (NDS) render 15-bit consoles into a 16-bit framebuffer
  and widen green with a plain shift, not bit replication, so those E2Es compare
  in **RGB555** (`to555` in `test/_emu-battery.ts`) — the console's real depth.
  The 565 cores (SMS/GG/MD/SNES) keep using `to565`.
- GBA/NDS 4bpp tiles are packed nibbles with the **left pixel in the low nibble**
  (`packPacked4Le`) — the mirror image of the MD's `packPacked4`. SNES 4bpp is a
  third layout again (`packSnes4`: plane pair 0/1 per row, then 2/3).
- The DS reuses the `gba` codegen emitter verbatim (identical 2D-engine formats);
  only the ROM edge differs. demake writes the `.nds` cartridge header itself
  (`cli/src/rom/nds.ts`) — ARM9 at ROM offset 0x4000 with entry 0x02000000, an
  ARM7 stub at 0x02380000, header CRC16 — so no ndstool or devkitARM is needed;
  the Nintendo logo area stays zero (direct boot never checks it, and we ship no
  copyrighted logo).
- ARM harnesses must keep their literal pool next to the code (`.pool` before the
  `.incbin` blobs): `ldr rX, =value` only reaches ±4 KiB and the tile blob is far
  bigger.
- SG-1000 (TMS9918 Graphics II) is _not_ a tiled sub-palette layout: its rule is
  two colors per 8×1 row, handled by `pipeline/fit-tms.ts` and validated by a
  dedicated oracle branch (there is no `subPalettes` on a `scanline` spec — don't
  cast it to `TileLayout`). Its Z80 harness reuses WLA-DX; the master palette is
  derived from genesis-plus-gx's native RGB565 `tms_palette`, not the 32-bit one.
- **The web app must never grow conversion logic.** Everything it shows comes
  from `@demake/core` through `src/worker/core.worker.ts` — console list,
  strategy portfolio, palettes, stats, manifest bytes. A second implementation
  of anything the CLI does (a manifest shape, a symbol-name rule, a console
  summary table) is how parity dies; if the web needs it, it moves into core
  first, as `buildManifest`/`encodeManifest` did.
- **CI's server-start traps, both learned the hard way.** (1) Actions sets
  `CI=1`, which makes Vite _colourise_ its banner — `Local:` arrives as
  `Local\e[22m:`, so any ready-pattern matching that literal never fires;
  `lighthouserc.json` matches the bare port and the job sets `NO_COLOR=1`.
  (2) Bound to the name `localhost`, the preview server can listen on `::1`
  alone while everything polls `127.0.0.1` — Playwright then dies on "Timed out
  waiting … from config.webServer" and Lighthouse audits an error page. The
  `preview` script therefore pins `--host 127.0.0.1 --strictPort`; keep it that
  way, and don't leave a stray preview on 4173 (Playwright reuses an existing
  server locally, even one serving a different base).
- Toolchain provisioners are best-effort by design (they must never break a
  session or a SessionStart hook), so **CI sets their `*_STRICT=1` variables**:
  a failed build then fails at the provisioning step with the tail of its build
  log, instead of silently skipping suites later. RGBDS additionally apt-installs
  its own build deps (bison, pkg-config, libpng-dev) — runner images ship libpng
  without its headers, which fails cmake in about a second.
- Web determinism has one extra trap the CLI doesn't: anything the _page_ feeds
  the engine must itself be engine-independent. That is why the bundled demo
  image (`src/lib/demo-image.ts`) uses no `Math.sin`/`Math.random` — the
  determinism spec converts it, so a transcendental there would turn a real byte
  mismatch into an untraceable one.
- The PNG encoder must stay deterministic (no libpng drift) once it exists.
- Source imports use explicit `.js` extensions (NodeNext ESM); Vitest resolves
  them to `.ts` via the workspace alias.

## Commit rules

- **No AI attribution of any kind in commits**: no `Co-Authored-By` trailers, no
  `Generated with` lines, no session links, no model names — in commit messages,
  PR titles/bodies, or code comments.
- **Never name other repositories or prior personal projects anywhere in this
  repository** — not in commit messages, docs, code, comments, or fixtures.
  This includes the earlier project this tool's design originated from: refer
  to it only generically (the docs use "the predecessor tools"). No project
  names, no links to it.
- Write commit messages about the change itself: imperative subject ≤ 72 chars,
  body explaining what and why (Conventional Commits).
- Develop on the designated feature branch; never push to `main` directly.

## Documentation rules

- `docs/` is the source of truth for design. If you change a decision, update
  every doc that states it (they cross-reference each other by number).
- Keep this file current: any workflow or convention you introduce that an agent
  needs on day one gets a line here, in the same PR.
