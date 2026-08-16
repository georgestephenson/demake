---
"@demake/ngp": minor
---

Model the Neo Geo Pocket processor's 8-bit interval timers.

`packages/ngp/src/timer.ts` implements the block the standalone audio cartridge
needs: the shared 9-bit prescaler and its gate, the per-timer clock selections,
the compare match that clears the up-counter, and the priority nibble that arms
the interrupt. Each is pinned against Toshiba's own datasheet rather than
against a driver that would agree with it, because that caller's proof is a
register diff and a register diff cannot tell a timer running at the wrong rate
from a schedule fitted to one.

**It is deliberately not wired into the machine**, and finding out why is what
this change is really worth. Building the cartridge on top of it produced one
that boots, takes the sound chip, programmes its clock and plays nothing —
because `TRUN` and the T6W28's right-hand write port are **the same byte**.
Toshiba's datasheet puts the timer run-control register at I/O `$20`; MAME's own
Neo Geo Pocket driver, which is where `NGP_SOUND_RIGHT` comes from, puts the
chip there. They cannot both be plain bytes of one 128-byte page, and nothing
this project could reach settles which reading is wrong for the part SNK
actually used.

So `@demake/ngp` keeps routing that page to the sound chip — which is what every
demade cartridge depends on and what the whole in-game audio battery proves —
and the timers stay a tested description rather than a peripheral. Two of the
new cases exist only to hold the conflict in place: one asserts that the block
claims the sound port, and one that the machine does not. If either ever stops
holding, the address question has been answered and the standalone cartridge is
a boot sequence, a clock and a wrapper away.

Four of the other cases are the ways a cartridge can programme this block and
get silence or a wrong tempo with every register write correct: the shared
prescaler left stopped, a reload of zero read as "every clock" rather than 256,
a clock selection that is not a division at all, and a priority of seven read as
"most urgent" rather than "off".
