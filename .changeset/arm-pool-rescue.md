---
"@demake/core": minor
---

Place an ARM literal pool automatically when a load would lose it

A 32-bit constant does not fit in a 32-bit instruction, so `ldrConst` queues one
and a later `ltorg` places it — within 4 KiB of the load, because the
displacement is twelve bits. A backend flushes at safe points it chooses, and how
far apart those are is a property of the game being compiled rather than of the
emitter: `quest` has a stretch of one rule body 4160 bytes long, sixty-four over,
and the build reported invalid code instead of a cartridge.

`AsmArm` now places a pool itself when the next instruction would put a queued
load out of reach, over a branch, right where it is still legal. Inserting one
between two instructions is safe here for three reasons and all three are
properties of this assembler: every jump is to a symbolic label, so nothing holds
a numeric offset that could go stale; a branch sets no flags, so a predicated
instruction still reads the comparison before it; and the pool is jumped over
rather than fallen into.

The backend's own `poolCheck` is unchanged and still decides where a pool
normally lands, which is what keeps it out of hot code — the rescue is a backstop
that fires only when the guess would have failed. Every example game but `quest`
compiles to the same bytes on both ARM consoles, and `quest` now builds and
traces on a Game Boy Advance and a Nintendo DS.
