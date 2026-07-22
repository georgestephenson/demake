---
"@demake/core": minor
"demake": minor
---

Broaden `prep`/`inspect`/`consoles` to 20 consoles and handhelds — every
RGB-lattice and mono raster platform in the doc-03 matrix now converts, reusing
the generic tiled fitter and mono path with no per-console quantizers:

- RGB-lattice tiled: SNES (RGB555, 8×16), Mega Drive (RGB333, 4×16), Master
  System (RGB222) + Game Gear (RGB444), GBA (Mode 0 tiled), NDS, PC Engine,
  Neo Geo, WonderSwan Color, Neo Geo Pocket Color — all with a shared transparent
  color 0 where the hardware has one.
- Mono: Virtual Boy (red ramp), WonderSwan / Neo Geo Pocket (8-shade gray),
  Watara Supervision, Tiger Game.com, Mega Duck (4 shades), Pokémon Mini (1bpp).

The public `inspect` cover now subtracts the shared backdrop before fitting cells
into P sub-palettes, so it can prove multi-palette output where a naive cover
fragmented. Every console is exercised by a parametrized suite: `prep` output is
sound-compliant (via the engine oracle) across gradient / flat / noise inputs and
snaps to each console's attribute grid.

Codegen backends, ROM harnesses, per-family toolchains, and the headless-emulator
E2E for these consoles follow (the GB family is already complete end to end).
