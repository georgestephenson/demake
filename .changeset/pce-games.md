---
"@demake/core": minor
"@demake/demotic": minor
"demake": minor
---

Compile a Demotic game into a PC Engine HuCard, and share the 6502 layer between
the two consoles that run it.

`demake build -c pce` produces a real cartridge — HuC6280 machine code written
for the game, art demade into 4bpp characters across fifteen sixteen-colour
sub-palettes — and the whole example library traces identically there, in the
same battery every other console runs, at the same one frame per tick. It is the
seventh backend and the first Tier 2 console to compile a game.

What it changed is mostly _shared_ code. `Asm6280` extends `Asm6502` rather than
restating it, because a HuC6280 is a 6502 with a memory mapper, block transfers
and a zero page at `$2000` — so `demotic/src/codegen/mos/` is now one copy of the
16.16 value layer, the expression compiler, the rule bodies, the tile walk and
step 6 of the tick, and two consoles run it. The NES's output bytes are unchanged.

New in `@demake/core`: `Asm6280` (`asm/huc6280.ts`), the HuCard wrapper
(`asm/pce-cart.ts`), and the `indZp` addressing mode the 65C02 line added.

New package `@demake/pce`: a self-hosted core — the CPU with its mapper and block
transfers, a HuC6270 scanline renderer over word-addressed video RAM, and the
HuC6260 colour table. It is the only core here with no dependency on
`@demake/chip`, because this console's six-channel wavetable PSG has no model
yet: a build emits no audio driver and the cartridge plays silently, while still
recording what a rule asked for in the byte a trace reads. The write tap is
already in place for the day the chip lands.

The page plays it too, as a seventh lazily-loaded core.
