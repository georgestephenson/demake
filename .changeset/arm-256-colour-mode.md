---
"@demake/core": minor
---

Give the sprite path a 256-colour mode, and declare it on the two ARM
handhelds.

`buildSpriteBank` now accepts `bpp: 8` and a `linear8` packing — a byte per pixel
in reading order, which is what the Game Boy Advance's and the Nintendo DS's 2D
engines read and which is not a bitplane arrangement at all. A caller selects it
with the new `mode` option, an index into `ConsoleSpec.modes`, and both consoles
now declare their 256-colour tiled layout there.

It is a *mode* rather than a change of primary layout, deliberately. `prep` fits
a still picture and the 4bpp sixteen-palette layout is what the display-ROM
harnesses and the pixel-perfect E2E were built against, so no existing output
byte moves. What asks for the new one is `demake build`: a cell in the 4bpp
layout gets sixteen colours chosen from one of sixteen banks, and in this one it
gets 256 with no per-cell restriction at all — a strictly larger space, because
*any* cell may use *any* colour. The cost is the tile budget, since a 256-colour
tile is 64 bytes rather than 32, which on 64 KiB of background character memory
is still 896 tiles against a 600-cell screen.

Two refusals rather than silent fall-backs: a bitplane packing on a
byte-per-pixel tile, and a mode index the console does not have. Quietly giving a
caller sixteen colours when it asked for 256 would produce art that is valid and
half the picture it asked for.
