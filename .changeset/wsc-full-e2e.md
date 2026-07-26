---
"@demake/core": minor
"demake": minor
---

WonderSwan Color fully end to end — the tenth console to pass the pixel-perfect
emulator loop, and the second of Tier 2 (doc 13 §Phase 5).

- **`wsc` codegen family**: the display controller's colour-mode background
  structures — 4bpp **row-major packed** tiles (left pixel in the high nibble,
  the format video mode `$E0` decodes), 2-byte screen-map words packing a 9-bit
  tile number, a 4-bit palette select, the tile bank and H/V flip, and 16
  sixteen-colour RGB444 palettes with colour 0 the shared backdrop. Available as
  `bin`, `asm` (NASM) and `c`.
- **V30MZ ROM harness**: `demake gen -c wsc --format rom` assembles a real
  4 Mbit cartridge through **NASM**. The WonderSwan's CPU is an 8086-compatible
  core, so a stock x86 assembler emitting a flat 16-bit binary is the native
  tool rather than an approximation; NASM builds the cartridge's last 64 KiB
  bank (the one the CPU answers segment `$F` with after reset) and demake packs
  the rest of the cartridge and the footer checksum itself, so no WonderSwan SDK
  is involved.
- **Pixel-perfect WonderSwan Color E2E** via beetle-wswan on the existing
  generic libretro runner, across the same extensive image battery every other
  family runs, in the core's native RGB565 — exact, because both sides expand a
  4-bit channel by replication.
- The mono WonderSwan (`ws`) stays prep-only and is now documented as such: its
  hardware needs a _tiled-mono_ fit path that does not exist yet, and its
  current spec is optimistic about what one tile can show (doc 13 §Phase 5).
