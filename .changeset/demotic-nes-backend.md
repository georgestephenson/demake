---
"@demake/core": minor
"@demake/demotic": minor
"demake": minor
---

Compile a Demotic game to the NES, and prove it plays the same game (doc 13
§D4). `demake build -c nes` produces a real NROM cartridge — 6502 machine code
written for that game, with its art demade by the image pipeline on the way —
and every game in the example library reproduces the reference interpreter's
fixed-point state tick for tick, in the same conformance battery both Game Boys
already run.

The way a game compiles is now an interface rather than a file. `Backend` is the
six questions a console answers — where state goes, what it cannot compile, how
its art and audio are demade, how many tiles it has, and how a plan becomes a
cartridge — and everything between those answers, including doc 14's seven tick
steps in doc 14's order, happens once in code neither console owns. So "the NES
plays the same game" is checkable by running the same code rather than by
comparing two files that resemble each other.

New in `@demake/core`: a 6502 assembler and an iNES cartridge wrapper, both on
the SM83 assembler's design, so the browser can build an NES cartridge with no
toolchain exactly as it already builds a Game Boy one. `prepSync` gains
`maxTiles`, the tile-bank counterpart of `maxSubPalettes`, because a full-screen
NES picture is 960 cells against a Game Boy's 360 and a caller that owns only
part of the bank has to be able to say so; `buildSpriteBank` gains `packing`,
because the two consoles arrange the same two bitplanes differently.

No existing output bytes change: both new options default to the behaviour that
was there before, and the Game Boy backend's cartridges are byte-identical.
