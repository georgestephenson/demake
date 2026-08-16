---
"@demake/audio": minor
---

Build a standalone Neo Geo Pocket audio cartridge.

`demake gen <schedule> -c ngpc --format rom` now produces a bootable flash
cartridge that plays a `ChipScript`, and `-c ngp` produces one a mono Neo Geo
Pocket will run — the tenth standalone in the set, and the seventh measurement
of the same claim: **the stream player is the processor's**. `ngp-driver.ts` is
not touched, because a game already drove it, so `rom/ngpc.ts` is a boot
sequence, a clock and a cartridge wrapper and nothing else.

The clock is what this cartridge exists for. A demade _game_ on this console
rides the picture, because its music and effects share one interrupt with the
frame; a cartridge whose only job is a schedule has no picture to share with and
a rate the frame cannot express, so it programmes timer 1 — the _upper_ timer,
because φT256 is the only prescaler output that reaches the bottom of a driver's
useful band and no single timer offers all four. The reload is read off the
schedule and the prescaler factored out of it, so the register a cartridge
programmes cannot disagree with the rate the schedule declares.

Three other things about it are this machine's. The chip has to be **asked for**
before a single port write is listened to, so the boot's first two stores are a
permission rather than a value. The handler is a **pointer in RAM** the boot ROM
dispatches through, written last so nothing can raise a tick before there is a
driver to perform it. And the interrupt's **priority is its enable**, where both
0 and 7 refuse — so arming it is a level rather than a bit.

Proven by doc 16's Level A on both machines, for a track and for a sound effect:
the ROM boots in `@demake/ngp` and every register write it makes is diffed
against the schedule tick for tick, with no tolerance.
