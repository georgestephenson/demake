---
"@demake/demotic": patch
---

Assert the board a swept fixture ships on, not its headroom

Banking took the teeth out of the size sweep and this puts them back. `free` is
measured against the largest board a console can build — which is the rule that
stops a game getting bigger from looking like a game with more room — and now
that every family pages, the largest board is megabytes: a Game Boy fixture
clears the sweep's one-kilobyte floor by eight million bytes.

What a size regression looks like today is a fixture that _takes a mapper_: a
cartridge four times the size, built through two extra assembly passes, for a
game the example library says should fit on the board it was written for. So the
sweep now asserts `stats.cartridge` against the board each fixture ships on,
which is exact rather than a threshold. Only the consoles with a fixture near an
edge are listed — a Mega Drive game is twenty-odd kilobytes of a 128 KiB floor,
so a number there would be a number to maintain and nothing else.

No output bytes change; this is test coverage that had gone quiet.
