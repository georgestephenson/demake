---
"@demake/demotic": minor
---

An entity record is as long as the object needs, not as long as the worst object
in the game.

RAM is the scarcest thing on every console here — an NROM cartridge adds none at
all to the NES's two kilobytes, and a Game Boy's eight are the whole budget for a
game's state — and the allocator was spending it on absences. Every instance got
the interpreter's full nine properties, 36 bytes, so a coin that never moves paid
for a speed, an x-direction and a y-direction it could not have, and a caption
that is drawn once paid for a value it does not hold.

`codegen/layout.ts` now allocates each record up to the highest slot the program
can _observe_:

- the collision box, always, because it is block-copied as a unit and every drawn
  object's position is read out of it;
- everything any rule, control or `on hold` restore can write;
- `value`, for a `number`, because the digit renderer reads it;
- the movement trio, for anything that can move.

Nothing else is stored, because nothing else can be seen: the backend already
folds an immutable `speed` or direction into the instructions that use it and
drops an object that cannot move out of the integrator entirely, and `visible` is
only loaded where a rule can write it. The property _order_ changed to suit —
`visible` and `value` moved ahead of the movement trio, so the objects that never
move stop at the shortest records — and the box still leads it, because that run
has to stay contiguous.

Across the example library that is 23–43% of each game's entity RAM: caves goes
from 684 bytes to 388, breakout from 576 to 344, pong from 360 to 244. It is also
cartridge, because the `Defaults_` table each record is restored from is now the
same length as the record.

Three things are threaded through `Layout.entitySizes` rather than recomputed, so
they cannot fall out of step: the boot restore, each scene's reset, and the table
they copy from. `rom/trace.ts` reads it too — a property with no storage is a
compile-time constant, and the oracle reports the declared value rather than
whatever the next object left at that offset.

**Output bytes change.** Every entity moves, so every cartridge does. No golden
trace moves with them: a trace is 16.16 _state_, and the state of a property
nothing can write is the number it was declared with, which is what the emitted
code was already using.
