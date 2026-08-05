---
"@demake/demotic": minor
---

Give the platformer, quest and runner the same jump on every console.

The same defect the caves had, in the three other fixtures that fall: gravity is
a delta a level rule adds every tick and nothing scales what a rule adds, so
`ydirection + 0.04` is an acceleration per _tick_ and a console ticking 75.47
times a second falls half again as hard as one ticking 60. All three now write
it against `fps` — `2.4 / fps` for the two heroes and quest's crawler,
`5.4 / fps` for the runner's bird — which folds to the constant the 60 Hz
consoles already had.

What it was costing on the WonderSwan, measured in the reference interpreter:

- **quest** jumped 4.02 cells against everyone else's 5.02, and its levels are
  absolute, so the four-row steps in the vault and the keep needed a rise of
  five to land on and could not be made at all. Two of its four levels were
  unfinishable there. The hero now rises 5.05.
- **platformer** was the odd point on its own curve. Its hero's speed is `55vw`,
  so the jump already scales with screen width by design — 5.02 cells on a Game
  Boy, 8.03 on a Master System, 10.04 on a Mega Drive — and the WonderSwan sat
  at 5.62 where a 28-cell-wide screen belongs at 7.03. It is on the curve now.
- **runner**'s flap cleared 0.64 cells there against 0.80 everywhere else, which
  is a fifth less height between pipes with the same gap.

Quest's two tick-counted _durations_ go the same way, because they are the same
mistake in a different unit: the mercy after a hit was 120 ticks — two seconds
on a 60 Hz machine and a second and a half on a WonderSwan — and is now
`2 * fps`, and the boss's bolt timer is read at `fps * 7 / 6` and `fps * 7 / 3`
rather than at 70 and 140 ticks.

The eleven 60 Hz consoles trace identically before and after, and their emitted
code does not change by a byte; the WonderSwan's cartridges change, which is the
point. Every cartridge moves four bytes of RAM (the division buys an expression
temporary the emitter folds away), so addresses shift.

Two things this turned up and did not change. The platformer's jump height
varies with screen width because a single `speed` drives both axes and its
shelves are placed in absolute rows — a fixture design question, not a rate one.
And `demake build <quest> -c gb` fails to assemble with its audio in
(`relative branch to 'AudioMusTickBlock' is 128 bytes away; use jp`) — that is
in the SM83 audio driver rather than the game, it predates this change, and it
survives because quest is the one example the Game Boy size sweep does not
build.
