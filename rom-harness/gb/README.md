# `gb` ROM harness

The minimal display program `demake gen --format rom` assembles around the
generated Game Boy / Game Boy Color data (doc 06 §ROM building, doc 10).

- **`main.asm`** — self-contained RGBDS source. It `INCLUDE`s the generated data
  (written next to it as `demake.asm`, symbol prefix `demake`), uploads the
  tiles, map, and palettes, and displays the image forever. One harness serves
  both consoles: `IF DEF(demake_pal)` selects the GBC path (BGR555 palettes + the
  CGB attribute map); otherwise it sets the DMG `BGP` register.

## How the CLI uses it

`demake gen --format rom -c <dmg|gbc>` runs the pipeline, emits the data as
RGBDS `asm`, drops it beside a copy of `main.asm` in a temp dir, and runs the
local toolchain:

```sh
rgbasm  -o main.o main.asm
rgblink -o out.gb main.o
rgbfix  -v [-C] -p 0xFF out.gb   # -C marks a CGB ROM
```

The toolchain comes from `tools/toolchains/install-rgbds.sh` (`pnpm toolchains`),
which pins a version and builds it from source into a cache — no Docker needed.
If RGBDS is not on `PATH`, `gen --format rom` fails with `E_TOOLCHAIN_MISSING`
and `bin`/`asm`/`c` still work.

## Producing a ROM by hand

```sh
demake gen portrait.png -c dmg --format asm --symbol demake -o build/demake.asm
cp rom-harness/gb/main.asm build/
( cd build && rgbasm -o main.o main.asm && rgblink -o portrait.gb main.o \
    && rgbfix -v -p 0xFF portrait.gb )
```

The doc-10 emulator screenshot test (headless SameBoy, pixel-perfect vs the
DAC-decoded reference) is the next step; the ROM it captures is the one this
harness builds.
