---
"@demake/demotic": minor
"@demake/core": minor
"@demake/web": minor
---

`demake build -c gba` compiles a Demotic game into a real Game Boy Advance
cartridge, and the whole example library traces identically on it.

The sixth backend, and the first whose console is bigger than the language needs
in every direction at once — so most of what is new here is machinery the other
five have that this one _does not_.

**The HUD gets a layer of its own.** Four independently scrolling backgrounds,
so a caption is background cells on a layer that never moves rather than
hardware sprites. The sprite HUD, the second decimal renderer that drives it and
the seven-pixel pin that can jitter are all absent, and a HUD cell is
`floor(pos) − floor(camera)` — stable whatever the camera's sub-cell offset is.

**A cell has 256 colours and no palette field**, and objects have a bank and a
palette of their own. A picture is fitted into one palette of 256 rather than
partitioned into sub-palettes, and a sprite's colours cost a backdrop nothing:
48 KiB of background character memory and 32 KiB of object, with 256 colours
each. The reservation for the font is therefore in _colours_ — three of 256,
against the quarter a Mega Drive gives up.

**The map is bigger than the screen on both axes**, so a scrolling scene paints
its leading edge where nobody is looking and there is no seam to mask. But 64×64
cells is four 32×32 screen blocks a kilobyte apart rather than a rectangle — the
Super Nintendo's tilemap hazard with two more blocks in it — so the address is
computed the hardware's way and `gba-rom.test.ts` checks every visible cell
against the level's own grid once the camera has crossed into each of them.

Three things are the instruction set's: a collision box is one `ldm` and one
`stm`, a short conditional is predicated rather than branched, and the decimal
renderer keeps its whole state in callee-saved registers across the call that
plots a glyph — which no other backend can do.

Two engine additions stand under it. `prep` takes a `mode`, so a caller can fit
into one of a console's selectable layouts rather than its primary one, and a
`maxColors` cap, which is `maxSubPalettes`'s counterpart for a console whose
palette is one flat block. `withMode` is the one place a mode is resolved, and
the `gba` codegen backend now emits 64-byte linear tiles when the layout it is
handed says 8bpp.

There is no sound on this console yet: the hardware has the Game Boy's four
channels _and_ two DMA-fed sample channels, and the ARM driver that would play a
demade schedule does not exist. A `.dmt` that names music compiles, records the
request its rules make, and traces identically to a build that played it.

No existing output byte changes: nothing else asks for a mode or a colour cap,
and every other console's memory map, palette and cartridge are what they were.
