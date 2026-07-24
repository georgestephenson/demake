---
"@demake/core": minor
"demake": minor
---

Tier 1 complete — the SNES, Game Boy Advance and Nintendo DS join the
pixel-perfect loop, so every launch-set console now goes image → compliant art →
native data → bootable ROM → emulator frame, proven bit-for-bit.

- **`snes` codegen backend**: Mode-1 background data — 4bpp SNES tiles (planes
  0/1 interleaved per row, then 2/3), little-endian tilemap words (10-bit tile
  index, 3-bit palette select, H/V flip) and eight 16-color BGR555 CGRAM
  sub-palettes sharing a transparent backdrop, which CGRAM entry 0 mirrors so a
  transparent pixel reproduces it exactly.
- **`gba` codegen backend**: Mode-0 text-BG data — 4bpp tiles in packed nibbles
  with the left pixel in the _low_ nibble, 2-byte screen entries (10-bit index,
  H/V flip, 4-bit palette bank) and 16 BGR555 sub-palettes.
- **`nds` codegen backend**: the DS 2D engines inherited the GBA's background
  formats, so the family reuses that emitter byte-for-byte (asserted by a test);
  only the cartridge differs.
- **Three new `--format rom` targets, no new heavyweight dependencies**: SNES via
  WLA-DX's `wla-65816` (the same toolchain the SMS and SG-1000 already build
  with, a different CPU), and GBA + NDS via the stock distro `arm-none-eabi`
  binutils (`install-arm.sh`, wired into `pnpm toolchains`). No devkitARM and no
  ndstool: the harnesses are pure assembly and demake writes the GBA and DS
  cartridge headers itself, including the DS header CRC16.
- **Pixel-perfect E2E for all three** across the shared extensive image battery
  (flat, full-screen gradient + noise, mirror, per-cell palettes, the 8×8
  minimum): snes9x, mGBA and DeSmuME, each through the one generic libretro
  runner. mGBA and DeSmuME widen 15-bit color into a 16-bit framebuffer with a
  plain shift, so those comparisons are made in RGB555 — the consoles' real
  depth — via a new `to555` reducer beside the existing `to565`.
- **DS emulator decision resolved** (doc 13 standing decision): DeSmuME, because
  it direct-boots a cartridge with no BIOS or firmware images, keeping the DS
  loop buildable from source in CI.
- **SNES harness detail worth knowing**: the PPU renders screen line N from BG
  line `VOFS + N + 1`, so the harness sets `BG1VOFS = -1`; with zero the image
  sits one pixel low.

No output-byte changes for consoles that already shipped.
