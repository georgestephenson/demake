---
"@demake/neogeo": patch
---

Add `@demake/neogeo`, a self-hosted Neo Geo core — the eleventh, and the one
that takes this console off doc 13's "gated on a BIOS we will not ship" list.

That entry was written when the proof loop was libretro-only, and owning the core
changes the question from "can we run somebody else's emulator" to "what does the
hardware do before it hands control over". The answer is three lines: take the
stack pointer from the cartridge's first longword and enter at the header's
`USER` vector. Commercial cartridges lean on the system ROM constantly — its
font, its soft dips, its coin handling — and one this project writes calls none
of it. Nothing copyrighted is shipped, reimplemented or needed, which is the
position `@demake/snes` already takes about the S-SMP's boot ROM and
`@demake/ngp` about SNK's other console.

The 68000 is `@demake/md`'s rather than a second transcription, on the terms
`@demake/nds` borrows `@demake/gba`'s ARM.

**The LSPC is where this console turns out to be cheap.** A sprite is a vertical
strip — sixteen pixels wide, up to thirty-two tiles tall, its column of tile
numbers a 64-word table in VRAM — so a row of strips is a plane of 16×16 cells,
and the sticky bit chains each strip to the one before it so all of them carry
_one_ position. Scrolling the playfield is a write to sprite 0's SCB3 and SCB4
and nothing else, which is cheaper than any scroll register in the set, and the
plane is 336 pixels against a 320-pixel screen so there is no seam to mask. Doc
13 priced this console at "all five background-cell writers need counterparts";
what they need is a different address calculation. The tests pin that mapping
directly, because it is what the backend will be written against.

Two other facts are modelled and easy to get wrong. The fix layer is a separate
8×8 map stored **column-major** and drawn in front of every sprite, so the HUD
gets a hardware layer and the sprite HUD every 8-bit console needs is absent. And
the **watchdog** reboots the machine after eight frames without a write to
`$300001` — modelled rather than ignored, because forgetting it is a class of bug
in generated code that produces a perfect cartridge and a console in a reset
loop, which no trace can name.

Two descriptions are unverified and say so rather than hiding it, on the
`NGP_BUTTON_BITS` precedent: which end of the sprite list wins a contested pixel,
and whether the dark bit is a per-colour flag or a sixth channel bit. The backend
above is written not to depend on the first.

The Z80 sound processor, the memory card, the calendar and the sprite shrinking
hardware are absent rather than half-implemented.
