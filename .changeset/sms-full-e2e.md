---
"@demake/core": minor
"demake": minor
---

Master System fully end to end — the third console family to complete the loop,
and the first through the libretro genesis-plus-gx core (which also covers Game
Gear / Mega Drive / SG-1000 for later).

- **`sms` codegen backend**: 4bpp row-interleaved planar tiles, a 2-byte name
  table (9-bit tile index + H/V flip + palette/priority bits), and a background
  palette — RGB222 (1 byte) on the SMS or RGB444 (2 bytes) on the Game Gear.
- **WLA-DX toolchain + z80 ROM harness**: `demake gen -c sms --format rom` builds
  a real `.sms` via `wla-z80`/`wlalink`. WLA-DX is provisioned by a pinned source
  build (`install-wladx.sh`).
- **Pixel-perfect SMS E2E** via genesis-plus-gx: prep→gen→ROM→emulator→framebuffer
  matches `renderCompliant`. genesis-plus-gx renders to a 16-bit framebuffer, so
  the comparison is in its native RGB565 precision — and demake's RGB222 DAC
  (now full bit-replication, `code*85`) matches the core exactly.
- The libretro provisioner gains the genesis-plus-gx core alongside fceumm.

`pnpm toolchains` also provisions WLA-DX.
