---
"@demake/core": minor
"@demake/audio": minor
"@demake/demotic": minor
"@demake/web": minor
---

`demake build -c ws` compiles a game for the mono WonderSwan — the same machine
code, on a quarter of the memory.

The thirteenth console to build a cartridge, and it is not a ninth backend: a
WonderSwan and a WonderSwan Color are one processor and one display controller,
so this is a **variant** on the Mega Duck's terms and what it added is
`codegen/wsc/machine.ts` — four entries and not one instruction. The whole
example library traces identically on it and plays its music and effects on it,
in the same two batteries every other machine runs.

The four entries are each a way a cartridge could be perfect and dark. There is
a quarter of the memory and the tile bank is the top half of it, so every
address in the plan moves and the heap is 2 KiB against 7 — the NES's budget on
a console with four times its screen. A tile is planar 2bpp, which is the Game
Boy's format rather than the Mega Drive's, so the built-in bank is called rather
than restated. A palette is thirty-six **ports** rather than five hundred and
twelve bytes of RAM, so `emitPaletteBlock` is the one place the two renderers
part company — and they part about the destination, not the bytes. And the
footer's minimum-system byte says a mono console may run this, which is a Game
Boy Color cartridge's `$C0` inverted.

One thing about the art is this machine's rather than a restatement. **Every
scene brings its own shade pool**, because the eight levels are a global choice:
a picture's fit chooses them and the objects and the font drawn over it ride
along without being refitted, since both name pool _slots_ rather than levels.
That is what `buildSpriteBank`'s new spread buys — an object's three shades are
spread across the pool by index rather than counted up from it, which on a
console where four entries choose among eight shades is the difference between a
sprite and three adjacent greys.

`@demake/core` gains the `ws` codegen family, so `demake gen -c ws` emits this
machine's data too: planar 2bpp tiles, the same screen-map word, and the pool and
palettes as the two register runs they are. The pool is **derived** from the
picture rather than stored in it, because a compliant image holds the level a
palette entry shows and not the slot it came from — one definition, so `build`
and `gen` cannot disagree about which slot is which.

**Output bytes change on the WonderSwan Color.** `WS_WAVE_BASE` moves from
`$3400` to `$0300`: the waveform page has to be sixty-four-byte aligned and below
`$4000` on both machines, and the colour one's roomy gap under its tile bank is
_tiles_ on the mono one. The interrupt vectors are what both have spare, because
neither cartridge takes an interrupt anywhere. No other console is affected.
