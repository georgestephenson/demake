---
"@demake/core": minor
"demake": minor
---

Complete the NES end to end and establish the universal emulator mechanism.

- **`nes` codegen backend**: plane-grouped 2bpp CHR (the 2C02 layout), nametable,
  packed attribute table (four 16×16 palette cells per byte), and a 16-byte
  palette with the shared backdrop. Emits bin/asm(ca65)/c(cc65).
- **NROM ROM harness + cc65 toolchain**: `demake gen -c nes --format rom` builds
  a real `.nes` via `ca65`/`ld65`. cc65 is provisioned by a pinned source build
  (`install-cc65.sh`), same pattern as RGBDS.
- **Universal libretro emulator**: a single headless `retrorun` frontend
  (`emu-harness/libretro/`) loads any libretro core, so every future console
  reuses one emulator harness — adding a console is adding its core, not a new
  capturer. `install-libretro.sh` builds the runner + the fceumm (NES) core from
  source.
- **Pixel-perfect NES E2E**: prep→gen→ROM→fceumm→framebuffer matches
  `renderCompliant` byte-for-byte across gradient/flat/noise. fceumm is pointed
  at demake's master palette via `nes.pal` (the same "calibrate the emulator to
  the model" approach as the GB DAC), so RGB is exact.

`pnpm toolchains` now also provisions cc65; `pnpm emulator` also builds the
libretro runner + NES core.
