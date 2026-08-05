---
"@demake/audio": minor
"@demake/demotic": minor
---

Fix the Game Boy audio driver's out-of-range branches.

The stream player is emitted _for a schedule_: a recording body per borrowable
channel, a merge loop, a preemption test, each present only if that schedule
needs it. So the distance a branch across the run walk has to cover is data
rather than a constant — and four of those branches were `jr`, which reaches
±128 bytes. Every Game Boy game in the example library places one or two sound
effects, so the widest driver any of them builds is two recording bodies short
of the one that breaks; a game placing an effect on all four channels assembles
to a branch 202 bytes out of range, and the assembler refuses (correctly, rather
than wrapping).

What that looked like: `demake build packages/demotic/fixtures/projects/quest -c gb`
died with `the code generator produced invalid code: relative branch to
'AudioMusTickBlock' is 128 bytes away; use jp` instead of the size refusal it
owed — that game compiles to 107 KiB and a mapper-less Game Boy cartridge holds
32 KiB, which is what it says now.

Every branch that jumps across the run walk is `jp`; `jr` is kept for what it is
for, a loop back to a label a few instructions up or a skip over one. The driver
grows 13 bytes, so every Game Boy, Game Boy Color and Mega Duck cartridge with
audio does too (the tightest, the shooter, has 2114 bytes free against 2127).

`packages/audio/test/gb-branches.test.ts` is the new guard, and it builds the
shape directly rather than through a fixture: four effects, one per channel,
with rests and a panning merge in the music. The game-audio battery cannot reach
this — it builds the example library, and the library has no such game — which
is why the bug shipped.
