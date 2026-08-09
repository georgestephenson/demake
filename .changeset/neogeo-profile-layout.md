---
"@demake/demotic": minor
---

Add the Neo Geo's console profile and RAM plan — the two answers a game backend
stands on, ahead of the backend itself.

The profile is what `demake trace -c neogeo` and the `.test.dmt` runner need, and
it carries the fact that shapes every later decision: **ninety-six sprites a
line**, against a Super Nintendo's thirty-two and an 8-bit console's eight. A
sprite here is sixteen pixels wide at its narrowest, so an object `w` cells wide
costs `ceil(w/2)` of them — the PC Engine's arithmetic on a budget six times
larger — and `E_SPRITE_BUDGET` effectively stops biting on this machine. The
total it advertises is 359 rather than the hardware's 381, because the playfield
spends twenty-one strips on itself and sprite 0 is the LSPC's own padding entry.

`NEOGEO_MEMORY` is sixty-four kilobytes at `$100000`, and one thing in it is
unlike every other console's. **An object's shadow entry carries its tile
numbers, not just its position**: everywhere else an object is a position and a
tile index in a fixed-size OAM entry, but a sprite here is a vertical strip whose
column of tile numbers lives in SCB1, so the runtime stages those too. That is
twenty bytes a strip against a Mega Drive's eight, and it is affordable only
because this console has sixty-four kilobytes of work RAM rather than two.

`audioBytes` is zero and says why: this console's sound answers a Z80 that
`demake build` emits no program for, so a cartridge is silent rather than
reserving state for a driver that does not exist.
