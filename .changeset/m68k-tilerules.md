---
"@demake/demotic": patch
"@demake/neogeo": patch
---

Move the 68000's tile walk, tile rules and tile contacts into
`codegen/m68k/tilerules.ts`, and correct the Neo Geo's sprite priority.

The tile block was the last part of the Mega Drive's emitter that was not the
Mega Drive's: three hundred and thirty lines with **zero** references to a video
register, a tilemap address or a palette. An object's cells come from the level's
own grid and the contacts land in bytes the RAM allocator placed, so a Neo Geo
runs those instructions unchanged despite sharing nothing about how a cell is
drawn. That is `mos/tilerules.ts`'s position one architecture along, and it takes
`md/emit.ts` from 2186 lines to 1848 — what is left there really is a renderer.
Every fixture's Mega Drive cartridge is byte-identical across the move.

**And `SPRITE_ORDER_FRONT_TO_BACK` was wrong.** The core shipped with a guess —
that a lower sprite index is drawn in front, the Super Nintendo's convention —
and the NeoGeo Development Wiki says the opposite: sprites are numbered by
priority, so a lower number is drawn _behind_ a higher one. Being a named
constant with the uncertainty written into its comment is exactly what made this
a one-line correction rather than an archaeology exercise, which is the
`NGP_BUTTON_BITS` rule paying for itself. A test now pins the direction.

The same source turned up a second fact: **sprite 0 belongs to the hardware.** It
is what the LSPC pads a line's display list with, is expected to be left
transparent, and is reported to draw over everything regardless of ordering — so
`FIRST_USABLE_SPRITE` is 1 and the backend's plane will start there.
