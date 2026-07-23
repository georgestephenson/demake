---
"@demake/core": minor
"demake": minor
---

Mega Drive / Genesis fully end to end — the fifth console to pass the
pixel-perfect emulator loop, and the first 68000 target.

- **`md` codegen backend**: 4bpp row-major packed tiles (32 bytes each, left
  pixel in the high nibble), a 2-byte VDP plane map (priority, 2-bit palette
  select, V/H flip, 11-bit tile index, big-endian), and four 16-color BGR333
  CRAM sub-palettes sharing a transparent backdrop. Tile 0 is reserved
  blank/transparent so the second scroll plane reveals the backdrop, not stray
  pattern data.
- **`md-vdp` DAC model**: reproduces genesis-plus-gx's Mode-5 normal-intensity
  color exactly (its `MAKE_PIXEL(2·code, …)` in 5:6:5), so the emulator
  comparison agrees to the bit. This changes `md` output bytes (color snapping
  now targets the true VDP levels rather than naive bit-replication).
- **m68k toolchain + ROM harness**: `demake gen -c md --format rom` assembles a
  real `.md` cartridge (68000 vector table + Sega header + VDP setup) via the GNU
  m68k binutils. Because a well-tested m68k assembler ships as a stock distro
  package, it is provisioned by apt (`install-m68k.sh`) rather than a source
  build; `pnpm toolchains` runs it.
- **Pixel-perfect MD E2E** via genesis-plus-gx across the shared extensive image
  battery (flat, full-screen gradient + noise, mirror, per-cell palettes, the
  8×8 minimum), plus CLI `--format rom` coverage for the `md` family.
