---
"@demake/demotic": minor
---

Copy an NES level's tables into every bank that reads one, so `quest` builds

The last of the six console families to page, and the only one that had to
duplicate a table to do it. Its window and its fixed half are the Game Boy's
sixteen kilobytes each, but its 6502 program is some four kilobytes bigger and
its characters cost the program nothing — so what would not fit below was the
level tables, at 16630 bytes of a 16384-byte fixed bank.

A Game Boy could leave them mapped and this cannot, because more than one step of
a scene reads a level and a paged routine cannot reach a table in another bank.
So each bank that reads a level carries its own copy of that level's grid, its
legend tables, its `TileAt` routine and its per-rule tile tables. That is one
field — `LevelData.suffix`, set by `levelCopy` — because every reader already
takes a `LevelData` and reads its labels off it, so no emitter has to know that
copies exist. The planner is where it shows: a bank is charged for the copies its
units drag in as well as for the units themselves.

Two smaller things fell out of building it. The audio driver's state is a
**second** pinned request on this CPU, beside the tile walk's cursor, because a
stream player walks its packed data through `($nn),y` like everything else here.
And a spilling request now leaves room for the pins still to come
(`Bump.tryTake`'s `keep`) — serving the pins first would move every address in
every game that already fits, so the spilling declines the last bytes of the page
instead.

`quest` builds on a 256 KiB MMC1 board with 8109 bytes of its fixed bank used,
and `rom.test.ts` traces it against the interpreter tick for tick, with its music
and effects in it. Every cartridge that fitted a mapper-less board is
byte-identical.
