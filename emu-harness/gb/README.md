# `gb` emulator capture harness

The headless capturer behind the pixel-perfect E2E (doc 10): it boots a
`demake gen --format rom` ROM in **SameBoy** (the GB/GBC accuracy reference) and
dumps the framebuffer for a byte-for-byte comparison against demake's
DAC-decoded reference.

- **`capture.c`** — a small program over SameBoy's public `libsameboy` API:
  load boot ROM + cartridge, run N frames, write the 160×144 framebuffer as a
  binary PPM. Color correction is **disabled**, so the output is the raw hardware
  readout — on CGB, RGB555 expanded as `(x<<3)|(x>>2)`, byte-identical to
  demake's `expandChannel`; on DMG, the exact green ramp passed in (in SameBoy's
  darkest-first palette order). That makes the capture directly comparable to
  `renderCompliant(image, /* raw on CGB */)` with **no** emulator-specific
  calibration.

## Provisioning

`tools/toolchains/install-sameboy.sh` (`pnpm emulator`) pins a SameBoy version,
builds `libsameboy` + its boot ROMs from source, and compiles `capture.c` into a
cached binary — no Docker, only `git` egress + a C compiler + RGBDS on PATH
(SameBoy assembles its boot ROMs with `rgbasm`). The boot ROMs are **SameBoy's
own open-source reimplementations**, built from source here — no Nintendo code.

## The E2E test

`packages/cli/test/emu.e2e.test.ts` runs the whole loop — image → prep → gen →
ROM → SameBoy → framebuffer → compare — and asserts **zero** mismatched pixels
for DMG and GBC. It self-skips when RGBDS or the capturer is absent, so the unit
suite stays green without them; provision with `pnpm toolchains && pnpm emulator`
to exercise it (web sessions get both via the `.claude/` SessionStart hook).

## Manual capture

```sh
pnpm emulator   # build the capturer + boot ROMs into the toolchain cache
CAP=~/.cache/demake/toolchains/sameboy-1.0.1
demake gen photo.png -c gbc --format rom -o out.gbc
"$CAP/capture" cgb "$CAP/cgb_boot.bin" out.gbc 300 frame.ppm
```
