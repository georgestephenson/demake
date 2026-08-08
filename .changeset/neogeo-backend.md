---
"@demake/demotic": minor
"@demake/neogeo": patch
---

`demake build -c neogeo` produces a playable Neo Geo cartridge, and the whole
example library traces identically on it.

The tenth console to build a game, the second to run a 68000, and the first whose
playfield is not a tilemap. Nothing moved out of `backend.ts` or `shape.ts` for
it, and the emitter owns only a renderer: the value layer, the expression
compiler, the rule bodies, the tile walk **and** the tile rules are all
`codegen/m68k/`'s, shared verbatim with the Mega Drive.

Four things about the renderer are this hardware's.

**The playfield is sprites.** Twenty-one vertical strips, each a column of tile
numbers in SCB1, every one after the first *sticky* — chained to the one before
it — so the whole plane carries a single position and scrolling is two writes.

**There is no edge painter**, and that is the 16×16 cell paying off. The plane is
21×15 cells where a Mega Drive's map is 64×32, so a full repaint is 630 words
through the VRAM port: a few thousand cycles out of two hundred thousand. Every
other backend paints a leading edge because a full redraw is too dear; here it is
not, so that whole mechanism is absent rather than reimplemented.

**The HUD is the fix layer**, in front of every sprite, on a grid that *is* the
language's cell grid. So there is no write queue, no erase list and no `PlotCell`
on this console — a caption is overwritten in place and a counter is blank-padded
to a fixed width. Three mechanisms every other backend needs, deleted by one
piece of hardware.

**The art is doubled.** A hardware tile covers a 2×2 block of language cells, so
the art path composes level grids, backdrops and objects into 16×16 tiles at
build time and dedups those. `ART_PALETTES` is 15 rather than the hardware's 256,
and it says why: that is a *cost* bound, not a capability one — a k-means
iteration is `O(pixels × centroids)` and 255 sub-palettes is a fit measured in
minutes for a picture with 280 cells to spend them on.

The one divergence worth recording is what the trace caught. Every position,
velocity and score matched on the first run; the only wrong field was `audio`,
because the backend never set `ctx.audio` and so recorded no sound *request*. A
trace's `audio` field is what the rules asked for rather than what a chip heard,
so a silent console must trace identically to a sounding one — which is why that
one line is what stood between eight failures and eight passes.
