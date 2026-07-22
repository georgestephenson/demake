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

`prep --emit-manifest` now also records the image hash so `gen --manifest` can
verify it. The `rom` format is recognized but deferred to the toolchain edge
(clear `E_TOOLCHAIN_MISSING`); the emulator ROM harness and the remaining Tier-1
consoles are the next Phase-2 steps.
