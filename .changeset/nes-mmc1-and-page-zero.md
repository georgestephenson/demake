---
"@demake/nes": minor
"@demake/core": minor
"@demake/demotic": minor
---

Give the NES a mapper, and let its page zero overflow into RAM

The NES has three walls between it and a game the size of `quest`, and this
takes the first two down.

**Page zero** is 237 usable bytes and a game with four levels wants 274, most
of it the two contact bitfields — which are read with `$nnnn,x` and never
followed, so they are exactly what should move. `MemoryPlan.fastSpills` now
applies to both 6502-family consoles, and what may _not_ move goes through a
new `pin`: the tile walk's cursor is `($nn),y` and nothing else the allocator
places is dereferenced at all, so a pointer that would not fit is refused by
name rather than assembling an instruction that reads the wrong two bytes.

**Work RAM** is the console's two kilobytes, and an NROM board adds none —
`quest`'s entities alone overrun it by eight bytes. `MemoryPlan.heapSpill` is
the eight kilobytes an **MMC1** board puts at `$6000`, filled only after the
console's own, so a game that fits keeps every address it had.

`@demake/nes` gains that mapper: sixteen kilobytes switched at `$8000`,
sixteen fixed at `$C000`, the RAM at `$6000`, and the five-write serial
register that lands a value on the fifth store with the destination decided by
the last store's _address_. Which mapper a cartridge is comes out of its own
header and is never a setting. One-screen mirroring is refused rather than
approximated.

Every cartridge that built before is byte-identical.
