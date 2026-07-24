# AGENTS.md — working in this repository

Guidance for coding agents (and humans) contributing to demake.
This file is the canonical project-memory file; `CLAUDE.md` is a one-line import
shim so Claude Code reads the same instructions. Keep all guidance here — never
add content to `CLAUDE.md` directly.

## What this is

A tool that converts any image into hardware-compliant art — and displayable
code — for 8/16-bit-era consoles and handhelds up to the Nintendo DS. The full
design lives in [`docs/`](docs/README.md); the milestone plan is
[`docs/13-roadmap.md`](docs/13-roadmap.md). **Current status: Phase 2 (in
progress)** — the Phase-1 engine spine is live (the deterministic image layer:
our PNG codec, color spaces, DAC models, seeded PRNG, math kernels; the
`ConsoleSpec` schema with the `gbc` and `dmg` specs; the tiled-and-mono
conversion pipeline with tournament + judge; the `inspect` compliance oracle).
Phase 2 is well advanced:

- **`prep`/`inspect` for 21 consoles** — every RGB-lattice and mono raster
  platform in doc 03 (GBC/DMG, NES, SNES, MD, SMS/GG, GBA, NDS, PCE, Neo Geo,
  WS/WSC, NGP/NGPC, VB, Pokémon Mini, Supervision, Game.com, Mega Duck) plus the
  SG-1000, through the one generic tiled fitter + mono path + the TMS9918
  Graphics II per-row two-color path (`pipeline/fit-tms.ts`). NES added
  `fixed-master` color, 16×16 attribute cells, and the shared-backdrop constraint.
- **Codegen** (`bin`/`asm`/`c`) for the `gb`, `nes`, `sms`, `md`, and `sg1000`
  families, reached via an exact-path detector, a manifest sidecar, or implicit
  `prep`.
- **`--format rom`** builds bootable ROMs for GB (RGBDS), NES (cc65 NROM), SMS +
  GG + SG-1000 (WLA-DX / Z80), and MD/Genesis (GNU m68k binutils). The z80/6502
  assemblers are pinned source builds; the m68k binutils is a stock distro
  package (apt, main archive) since a well-tested one ships there — all via
  `pnpm toolchains`, no Docker.
- **Pixel-perfect emulator E2E** for GB (SameBoy), NES + SMS + GG + MD + SG-1000
  (libretro cores via one generic `emu-harness/libretro/` runner), all marching
  through the same shared extensive image battery
  (`packages/cli/test/_emu-battery.ts`).

Still to come: codegen + rom + E2E for the remaining consoles (each = a codegen
backend, a ROM harness + toolchain, and a libretro core + DAC calibration),
plus the remaining framebuffer/scanline layout paths (Lynx, GBA bitmap,
2600/7800).

## Layout map

```
packages/core/       @demake/core — the engine (zero platform deps; ESM; ships types)
  src/math/          deterministic kernels (exp/log/pow/cbrt/sin) + PCG32 PRNG
  src/color/         sRGB/linear/Oklab, hardware-lattice snapping, color parsing
  src/image/         PNG codec (inflate/deflate/decode/encode), DAC models, decode dispatch
  src/consoles/      ConsoleSpec schema + one declarative spec per console (21 of them)
  src/pipeline/      stages 0–7, the tiled fitter, mono + TMS row-pair paths, tournament
  src/codegen/       gen: per-family backends (gb, nes, sms, md, sg1000), exact-path detector
  src/inspect/       compliance oracle (inspect) + fidelity judge
packages/cli-spec/   @demake/cli-spec — single source of truth: spec → parser, help, man
packages/cli/        demake — thin CLI over core; re-exports core for scripting
  src/rom/           edge: assemble `--format rom` per family (RGBDS / cc65 / WLA-DX / m68k)
  man/               generated roff man pages (never hand-edited)
rom-harness/{gb,nes,sms,md,sg1000}/  the display programs `gen --format rom` assembles
emu-harness/gb/      SameBoy headless capturer for the GB pixel-perfect E2E (doc 10)
emu-harness/libretro/  generic retrorun frontend — one capturer for every libretro core
tools/toolchains/    provisioners (cached): RGBDS, cc65, WLA-DX, SameBoy source builds;
                     GNU m68k binutils (apt); libretro cores (fceumm, genesis-plus-gx)
tools/eslint-rules/  custom ESLint rules: platform-purity + determinism
docs/                the design plan; source of truth for decisions
```

Packages not yet created (web, desktop, testdata) arrive in later phases per
doc 02.

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
pnpm toolchains    # provision RGBDS (source build, cached) for `gen --format rom`
pnpm emulator      # provision the headless SameBoy capturer for the pixel-perfect E2E
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
- **`CLAUDE.md` stays a pure `@AGENTS.md` import** (CI-checked, doc 12).
- **Commands named in this file must exist as `package.json` scripts** (CI
  staleness check, doc 12) — update both together.

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
- SG-1000 (TMS9918 Graphics II) is _not_ a tiled sub-palette layout: its rule is
  two colors per 8×1 row, handled by `pipeline/fit-tms.ts` and validated by a
  dedicated oracle branch (there is no `subPalettes` on a `scanline` spec — don't
  cast it to `TileLayout`). Its Z80 harness reuses WLA-DX; the master palette is
  derived from genesis-plus-gx's native RGB565 `tms_palette`, not the 32-bit one.
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
