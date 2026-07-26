---
"@demake/demotic": minor
---

Pack an NES backdrop's nametable instead of storing it raw. A screenful is 960
cells and an NROM cartridge is 32 KiB, so a game with two pictures was spending
six per cent of its program on them — enough to put the shooter, whose nine aliens
generate a lot of collision code, within a few hundred bytes of not fitting once
it has music. A demade screen is mostly runs, so the cells and the attribute table
go in as literals and runs and come back out through one walk with rendering off:
960 bytes becomes 279–682.

The example library gains 280–560 bytes per picture — the shooter 944, taking it
from 1,450 bytes free to 2,394.

What is guaranteed is the bytes that reach the PPU, not the encoding, so the test
boots the cartridge and reads the PPU's own memory rather than checking the
format.

NES cartridge bytes change.
