---
"@demake/demotic": patch
---

Add the Neo Geo's arithmetic oracle, and confirm the vertical-blank acknowledge.

`neogeo-arith.test.ts` looks like a subset of `md-arith.test.ts` on purpose, and
it is here for `pce-arith.test.ts`'s reason one architecture along: the emitters
are the same file, so what it proves is not the arithmetic a second time but that
the same instructions still mean the same thing on a machine that puts everything
somewhere else. Work RAM is at `$100000` rather than `$FF0000`, the program is
entered through a header rather than a reset vector, and the cartridge is a
container the code has to survive a round trip through — any of which could break
every routine at once while the Mega Drive's file stayed green. The first case
asserts exactly that and would fail before any arithmetic was wrong.

The frame handler's `REG_IRQACK` write is now verified rather than defensive.
Vertical blank is bit 2 (bit 4 is IRQ1, bit 1 is IRQ3), so `#4` would do — but
`#7` is what commercial cartridges write, clearing a flag that is not set is a
no-op, and an interrupt left pending re-enters the moment the mask drops and runs
the whole game thousands of times too fast with every register write correct.
That is the failure the Sega audio suite exists to catch, and `#7` cannot be
wrong in that direction.
