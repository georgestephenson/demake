---
"@demake/demotic": minor
---

Give each NES picture a pattern table of its own. The console has two and
`PPUCTRL` bit 4 chooses which one the background layer reads, so a game's
backdrops no longer halve one table between them: across the example library a
picture's budget goes from 96 patterns to 162–192, and the shooter's title screen
goes from merging 216 of its 960 cells to merging 57. Level art still shares
table 0 and object art table 1, so the budget each picture is offered is exactly
what the table it lands in has left.

The budget is the only thing a build decides about a picture — the conversion is
`prep`'s, through the same `prepSync` call and the same image backend — and
`nes-rom.test.ts` now checks that by demaking each backdrop again at the reported
budget and comparing the pattern behind all 960 cells, plus its attribute table.

NES cartridge bytes change.
