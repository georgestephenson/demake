---
"@demake/neogeo": minor
---

Give the core its sound side: a Z80, a YM2610, and the one byte in each direction
between the two processors.

This is the third console in the set whose sound runs on a processor of its own
and the most separate of the three. A Super Nintendo's SPC700 is _uploaded_
through four mailbox bytes at boot; a Nintendo DS's ARM7 is the cartridge's other
binary in memory both processors share. This Z80 has **its own ROM on its own
bus** and is running before the 68000 has done anything at all.

Four things follow, and each is a case in `sound.test.ts` because each is a way a
cartridge can be perfect and silent. **A request is an NMI**, refused until the
driver reads port `$08` and acknowledged by reading the command rather than by
clearing anything. **The chip's timer interrupts _this_ processor** — a Mega
Drive has the same arrangement with the wire the other way round, which is why a
game there has to poll from a loop that is also running a game and a driver here
does not. **The interrupt is level triggered**, because the chip holds its
overflow flag until the driver clears it: a handler that forgot would be
re-entered for ever, and modelling it as an edge would hide exactly that. And
**the two port pairs are different register spaces**, so a model that routed both
to one place would run a timer nobody started.

The chip is advanced **between instructions rather than in a lump**, which is the
one thing the run loop has to get right: a caller hands over a frame at a time,
and advancing the chip by all of it first runs hundreds of timer overflows into
one flag — so the driver takes one interrupt where the hardware gives it hundreds
and plays at whatever rate the caller happened to poll at. The three clocks divide
exactly (12, 4 and 8 MHz), so nothing about that is approximate.

The tests also record two Z80 rules a generated driver has to keep: this processor
comes up with **no usable stack** — the only RAM it has is two kilobytes at
`$F800` — and an interrupt handler that does not save `af` corrupts the code it
interrupted rather than merely being slow.
