---
"@demake/core": minor
"demake": minor
---

Phase 2 (part 1) — code generation (`gen`) for the Game Boy family.

`gen` turns an image into the data and source a retro developer (or our own ROM
harness) uses directly, generalizing `gen-portraits.py` to the declarative
console model:

- **Codegen framework**: a uniform, tested per-family backend contract
  (`codegen/types.ts`) and a family registry. The `gb` backend covers both GBC
  (BGR555 sub-palettes + a CGB attribute map) and DMG (a computed BGP register),
  driven entirely off the `ConsoleSpec`.
- **Three formats**: `bin` (raw hardware-layout blobs for `incbin`), `asm`
  (idiomatic RGBDS with backtick 2bpp graphics rows), and `c` (GBDK-style arrays
  plus a header of extents and palette counts). `--symbol`, `--tile-base`, and
  `--map-base` control layout.
- **Flip-aware tile dedup**: unique 8×8 tiles are emitted once; the map records
  the H/V flip needed to reproduce each cell (doc 06 §Tile handling).
- **Two input paths**: an exact-path detector reconstructs a compliant image
  from already-compliant pixels losslessly, and a supplied `prep --emit-manifest`
  sidecar pins palette order (hash-matched). Anything else is implicitly prepped
  first; `--strict` disables that fallback.
- **Output hygiene**: every artifact carries tool+version, source hash, the
  option string, and a "regenerate with" line — pure ASCII, no timestamps, so
  output stays byte-deterministic.
- **CLI**: `demake gen` is live (was advertised-but-planned), with `--json`
  reporting every file written with byte sizes and content hashes.
- **`--format rom`**: builds a bootable `.gb`/`.gbc` from the generated data via
  an on-disk `rom-harness/gb/` harness (one source, DMG + GBC by conditional
  assembly) and the local RGBDS toolchain (`rgbasm`→`rgblink`→`rgbfix`). RGBDS is
  provisioned by `tools/toolchains/install-rgbds.sh` (`pnpm toolchains`), which
  resolves fastest-acceptable-first: reuse an rgbds already on PATH, else a
  cached build, else an opt-in prebuilt tarball (`$RGBDS_PREBUILT_URL`), else a
  pinned source build (git clone + cmake, ~13s, cached) — no Docker, only `git`
  egress. A `.claude/` SessionStart hook installs it automatically in
  managed/web sessions. Missing toolchain yields a clear `E_TOOLCHAIN_MISSING`;
  `bin`/`asm`/`c` never need it.

- **Pixel-perfect emulator E2E (doc 10 — the credo)**: the full loop
  prep→gen→ROM→emulator→framebuffer now proves out for the `gb` family. An
  on-disk `emu-harness/gb/capture.c` boots the ROM in SameBoy (the accuracy
  reference) via its public `libsameboy` API with color correction disabled, and
  the framebuffer matches `renderCompliant` **byte-for-byte** for both DMG and
  GBC. SameBoy is provisioned like RGBDS — pinned source build, cached, no Docker
  (`tools/toolchains/install-sameboy.sh`, `pnpm emulator`) — and the SessionStart
  hook installs it. `packages/cli/test/emu.e2e.test.ts` runs the comparison and
  self-skips without the toolchains.

`prep --emit-manifest` now also records the image hash so `gen --manifest` can
verify it. The remaining Phase-2 step is Tier-1 console breadth (NES → SMS → MD →
SNES → GBA → NDS), each extending the same rom + emulator harnesses.
