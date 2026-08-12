---
"@demake/demotic": minor
"@demake/core": minor
---

Spread a WonderSwan program across segments, so `quest` builds there

The eighth console family, and the only one where the answer was not a mapper.
Segments `$8`–`$F` are all cartridge and all mapped from reset — `BANK_LINEAR`
comes up all-ones — so a 512 KiB image is entirely addressable and a demade
cartridge never writes a banking register. What a game outgrows is a **segment**:
64 KiB, and `quest`'s code alone is 77 of them.

So this takes the Super Nintendo's answer rather than the Sega's: a **scene per
segment**, reached by `call far` and returned from by `retf`. The switch is
all-or-nothing for the Super Nintendo's reason — the near and far pairs push
different amounts of stack, so which one a routine ends with has to match how
every caller reaches it — and a game that fits one segment is assembled exactly
as it always was.

What is this console's rather than the Super Nintendo's is the **`cs:` override**.
A cartridge table is read through the code segment and a block copy takes `DS`
from `CS`, so a routine in segment `$E` reads segment `$E`'s tables or nothing.
There is no spare segment register to point at the data instead: this CPU has
four and a demade cartridge already spends `DS`, `ES` and `SS` on RAM — `ES`
looks free and is not, because it is the destination of the `rep movsw` that
stages every collision box. So **each segment carries the tables its own code
reads**: the level grids, the instance defaults, the backdrops and the constant
pool. That is the NES's duplication reached by completely different hardware.

`quest` builds on the one board this console's header can describe, and
`rom.test.ts` traces it against the interpreter tick for tick. Every cartridge
that fitted one segment is byte-identical.

The mono WonderSwan still does not build it, and the wall is **work RAM** rather
than the cartridge: 3957 bytes of heap against 2048, because that machine has
sixteen kilobytes with its tile bank in the top half. No cartridge size can fix
that; the hardware's answer is SRAM behind a segment register, which is a change
to the memory model rather than to the banking.
