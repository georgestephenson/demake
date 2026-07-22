# Retro Game Art Maker — Project Plan

This directory is the complete planning document set for **Retro Game Art Maker**
(working CLI name: `retroart`), a tool that converts arbitrary modern images into
hardware-compliant art — and displayable code — for every major game console of the
8/16-bit home era and every handheld up to and including the Nintendo DS.

The plan is written to be executed incrementally, but it describes the *finished*
product. Nothing here is aspirational hand-waving: every document is specific enough
that an engineer (human or agent) can pick up a section and implement it.

## Document index

| # | Document | Contents |
|---|----------|----------|
| 01 | [Vision & Goals](01-vision-and-goals.md) | What we are building, for whom, guiding principles, non-goals |
| 02 | [Architecture](02-architecture.md) | Monorepo layout, the isomorphic core, how CLI / web / desktop / package share one engine |
| 03 | [Console Matrix](03-console-matrix.md) | Every target console, its hardware constraints, support tiers |
| 04 | [Conversion Pipeline](04-conversion-pipeline.md) | The "prep" engine: parallel candidate-algorithm tournament + multi-metric judge; color science, scaling, quantization, palette fitting, dithering |
| 05 | [CLI Specification](05-cli-spec.md) | UNIX-compliant CLI: subcommands, flags, exit codes, man pages, agent-friendliness |
| 06 | [Code Generation](06-codegen-spec.md) | The "gen" path: per-console data formats, source output, full-ROM output |
| 07 | [Web App](07-web-app.md) | Browser version on GitHub Pages, fully client-side |
| 08 | [Desktop App](08-desktop-app.md) | Tauri app wrapping the CLI as a sidecar |
| 09 | [Library API](09-library-api.md) | The npm package: public API surface, determinism guarantees |
| 10 | [Testing Strategy](10-testing-strategy.md) | Unit/property tests plus the ROM → headless emulator → pixel-perfect screenshot pipeline |
| 11 | [CI & Releases](11-ci-and-releases.md) | GitHub Actions workflows, versioning, publish pipelines |
| 12 | [Repo Standards](12-repo-standards.md) | AGENTS.md (with CLAUDE.md import shim), README, contribution standards, engineering conventions |
| 13 | [Roadmap](13-roadmap.md) | Phased milestones with acceptance criteria |

## Provenance

The design generalizes two proven single-purpose tools from the
an earlier project by the same author project:

- `tools/prep-portraits.py` — quantizes a 112×112 source to a small master palette
  (median cut + weighted k-means), downscales 2× by per-block majority vote, then fits
  3 × 4-color palettes across a 7×7 tile grid by alternating assignment/refit with
  deterministic restarts, and snaps to RGB555.
- `tools/gen-portraits.py` — converts prepped 56×56 images into RGBDS assembly:
  BGR555 palettes, per-tile palette map, and 2bpp tile data, with an *exact* lossless
  path for compliant inputs and a lossy fallback for anything else.

`retroart prep` and `retroart gen` are those two tools, generalized to a declarative
per-console constraint model, a smarter perceptual pipeline, and ~30 target platforms.
