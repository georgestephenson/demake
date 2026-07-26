---
"@demake/core": minor
"demake": minor
---

PC Engine fully end to end — the ninth console to pass the pixel-perfect
emulator loop, and the first of Tier 2 (doc 13 §Phase 5).

- **`pce` codegen family**: HuC6270 background structures — 4bpp **word-planar**
  characters (words 0–7 carry bitplanes 0/1 of each row, words 8–15 bitplanes
  2/3), 12-bit-character + 4-bit-palette BAT words, and 16 sixteen-color VCE
  sub-palettes as 9-bit `GGGRRRBBB` words with color 0 the shared backdrop.
  Available as `bin`, `asm` (WLA-DX) and `c`.
- **HuC6280 ROM harness**: `demake gen -c pce --format rom` assembles a real
  64 KiB HuCard through `wla-huc6280` — a fourth CPU target on the WLA-DX build
  the SMS, SG-1000 and SNES families already provision, so no new toolchain. The
  harness maps ROM banks 1–5 as one 40 KiB window and block-transfers the
  characters, BAT and palettes straight into the VDC and VCE ports.
- **Pixel-perfect PC Engine E2E** via beetle-pce-fast on the existing generic
  libretro runner, across the same extensive image battery every other family
  runs. No new DAC model was needed: the core's `36 × code` expansion and
  demake's bit replication agree on every 3-bit code in RGB565, the core's own
  framebuffer depth.
