# 01 — Vision & Goals

## One-sentence pitch

Give it any image and a console name; get back an image that the real hardware could
actually display — or the source code that displays it.

## The problem

Every retro console has a different, brutal set of graphics constraints: master
palettes, per-tile color limits, sub-palette counts, attribute granularity, tile
budgets, fixed resolutions. Turning modern art (or photos, or AI-generated images)
into something a Game Boy Color or a Mega Drive can display is a specialist task
today, solved per-project with one-off scripts (exactly what `prep-portraits.py` /
`gen-portraits.py` were). General-purpose image tools (ImageMagick, Photoshop) can
quantize colors but know nothing about *per-tile* palette constraints, attribute
grids, or console color DACs — so their output is not actually hardware-compliant.

## What we are building

One engine, four faces:

1. **CLI** (`retroart`) — a first-class UNIX citizen. Composable, scriptable,
   pipe-friendly, man-paged, versioned, with machine-readable output. Designed so
   that Claude Code, Codex, and other coding agents can drive it without friction.
2. **Web app** — the same engine compiled for the browser, hosted free on
   `github.io`. Drag an image in, pick a console, see a live preview, download the
   PNG or the generated code. Zero server, zero upload — everything runs locally.
3. **Desktop app** — a deliberately simple GUI (Tauri) that bundles the CLI as a
   sidecar binary and shells out to it, so GUI behavior is *by construction*
   identical to CLI behavior.
4. **Library** — an npm package (`retroart` / `@retroart/core`) exposing the engine
   programmatically for build pipelines, game engines, and other tools.

Two core operations (mirroring the predecessor tools):

- **prep**: any image, any size, any color depth → a hardware-compliant image for a
  chosen console (and optional target size), preserving as much perceptual fidelity
  as the hardware allows.
- **gen**: a source image (raw or prepped) → data + display code for that console
  (palettes, tiles, maps, in the native format), optionally up to a complete,
  buildable, bootable ROM that displays the image.

## Goals

- **G1 — Correctness above all.** "Compliant" means *provably displayable*: the CI
  pipeline builds a real ROM from our output, runs it in a headless emulator, and
  verifies the screenshot pixel-perfectly. If we claim NES support, an NES emulator
  shows our image.
- **G2 — Best-in-class conversion quality.** Perceptual color spaces, per-tile
  palette optimization, content-aware scaling, optional dithering — the smartest
  published techniques, selected automatically but overridable (see doc 04).
- **G3 — One deterministic engine.** The exact same TypeScript core runs in Node,
  the browser, and the desktop app. Same input + same options + same version =
  byte-identical output on every platform. Determinism is a tested guarantee.
- **G4 — Full platform coverage.** Every home console through the 16-bit (fourth)
  generation and every handheld through the Nintendo DS, tiered by ecosystem
  maturity (doc 03), with the constraint model designed so adding a console is
  writing one declarative spec file plus one codegen backend.
- **G5 — Agent-native UX.** Structured `--json` everywhere, self-describing
  capabilities (`retroart consoles --json`), precise machine-parseable errors,
  exhaustive `--help`, an `AGENTS.md` contract file. An LLM should be able to learn
  the whole tool from its own output.
- **G6 — Exemplary engineering.** Full CI, automated releases, semver, man pages,
  CLAUDE.md, high test coverage, typed public API, reproducible builds.

## Non-goals (explicit)

- **Not an animation/sprite-sheet tool** (v1). We convert single still images. The
  constraint model deliberately distinguishes background vs sprite modes so
  animation support can come later, but v1 targets full-screen/partial still images.
- **Not a pixel-art editor.** No drawing tools. Other tools (Aseprite, etc.) do that.
- **Not an emulator or a game engine.** We *use* emulators in CI; we don't ship one.
- **No vector-display consoles.** The Vectrex draws vectors, not pixels; a raster
  converter is meaningless for it. Documented as excluded, not "TODO".
- **No servers.** The web app is static. There is no backend, telemetry, or upload.

## Naming

Recommended name: **`demake`** (binary, npm package, repo). A *demake* is the
beloved fan practice of remaking a modern game for retro hardware — which is
exactly, literally what this tool does to an image. It's a verb, so CLI usage
reads as a sentence (`demake photo.jpg --console gbc`), it's short, memorable,
and npm-free (verified 2026-07; `retroart`, `retropix`, `retrofy`, `tilepress`
also free as runners-up). Plan documents use `retroart` as the placeholder until
the rename decision; Phase 0 finalizes it after the full collision check
(npm / GitHub / Homebrew / PyPI-squatting / trademark scan) and reserves the
scope fallback (`@demake/*`).

## Success criteria for v1.0

1. `retroart prep photo.jpg --console gbc -o out.png` produces a compliant GBC image
   from any input, and `retroart gen out.png --console gbc --format asm` produces
   RGBDS assembly at least as good as `gen-portraits.py` output.
2. All Tier 1 consoles (doc 03) pass the full ROM-in-emulator screenshot test in CI.
3. The web app on github.io produces byte-identical PNGs to the CLI for the same
   options.
4. `npm i -g retroart` and the desktop app installers work on Linux/macOS/Windows.
5. `man retroart` works and the docs site is generated from the same source of truth.
