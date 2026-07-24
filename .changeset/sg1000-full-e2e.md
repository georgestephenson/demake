---
"@demake/core": minor
"demake": minor
---

SG-1000 fully end to end — the sixth console to pass the pixel-perfect emulator
loop, and the first with a bespoke fit path.

- **TMS9918 Graphics II fit (`pipeline/fit-tms.ts`)**: the SG-1000's defining
  constraint is not a sub-palette but _two colors per 8×1 tile row_, so each row
  segment is an independent two-color quantization against the fixed TMS master.
  It is expressed as a `CompliantImage` with 8×1 attribute cells, so
  `renderCompliant`, the codegen, and a new oracle branch all reuse the existing
  machinery. Selected by the `tms-rowpair` scanline layout; a three-candidate
  portfolio (flat / Floyd–Steinberg / Bayer) feeds the tournament.
- **`sg1000` console + codegen family**: a fixed 16-color master derived from
  genesis-plus-gx's native RGB565 `tms_palette` (so the RGB565 comparison is
  bit-exact), and an 8-byte pattern + 8-byte color table per tile.
- **Z80 ROM harness**: `demake gen -c sg1000 --format rom` assembles a real `.sg`
  via WLA-DX (no new toolchain), programming the VDP for Graphics II and uploading
  the three 256-tile VRAM banks + name table with the display off.
- **Pixel-perfect SG-1000 E2E** via genesis-plus-gx across the shared extensive
  battery, plus CLI `--format rom` coverage and codegen/oracle unit tests. The
  registry now holds 21 consoles.
