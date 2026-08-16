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
from a schedule fitted to one. Their interrupts dispatch the way the picture's
does — through a pointer the cartridge writes into the boot ROM's own table.

Four of the cases are the ways a cartridge can programme this block and get
silence or a wrong tempo with every register write correct: the shared prescaler
left stopped, a reload of zero read as "every clock" rather than 256, a clock
selection that is not a division at all, and a priority of seven read as "most
urgent" rather than "off". Two more hold the block and the sound chip apart —
these registers are the _processor's_ at `$00`-`$7F` and the ports are the
_console's_ at `$80`-`$BF`, and a block that claimed one of them would swallow
the write and leave a cartridge playing silence with a perfect register page.

Wiring it in is also what found four addresses in the machine description to be
sixteen bytes low, which is a separate change.
