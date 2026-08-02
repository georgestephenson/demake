---
"@demake/core": minor
"@demake/demotic": minor
"@demake/gba": minor
"@demake/nds": minor
"@demake/web": minor
---

Compile a Demotic game into a Nintendo DS cartridge, for the price of a machine
description.

`demake build -c nds` produces a real `.nds` carrying the **same ARM machine
code** a Game Boy Advance build carries, and the whole example library traces
identically there, in the same battery, at the same one frame per tick. It is
not a seventh backend: a DS's 2D engine A _is_ a Game Boy Advance's — the same
mode-0 text backgrounds at the same register offsets, the same screen entries,
the same 4bpp and 256-colour characters, the same object attributes, the same
DMA word — so this is a variant on the terms the Mega Duck settled, and what it
added is `codegen/gba/machine.ts` and not one instruction.

Five entries, and each of them is a way a cartridge can be perfect and dark:

- **The program is copied rather than run.** There is no cartridge in the
  address space at all, so the header is a 16 KiB region in front of the image
  instead of the first 192 bytes of it, and the limit on a build is the megabyte
  before its own heap rather than a bus.
- **A video RAM bank has to be pointed somewhere** before anything is uploaded
  into it, and background and object characters are two banks rather than one
  array with the objects on top.
- **`DISPCNT` is a word here**, and the field that decides whether the engine's
  output reaches the screen at all is in the half a halfword store never writes.
- **The window is 32×24**, so a build that kept the other machine's would leave
  two columns and four rows of every scene unpainted.
- **The main loop watches the beam.** This machine's interrupt vector is inside
  data TCM and its base is a CP15 setting rather than an address — a description
  to get exactly right for a gain of nothing, since the loop is what waits
  either way.

`@demake/nds` is the seventh self-hosted core and the smallest: the processor is
`@demake/gba`'s `Arm7` and the picture is its `Ppu`, because on everything a
demade game touches they are the same processor and the same engine. What is
there is the machine around them — 4 MiB a cartridge is copied into, nine video
RAM banks of which two are mapped, and a screen a third bigger. 2D engine B, the
second screen, interrupts and the ARM7 are absent rather than half-implemented,
and each of them raises by name.

`Ppu` gained a `PpuOptions` argument so that one engine can serve two screens.
Both machines pass their own video memory: an engine that allocated its own is
a picture uploaded to one array and read from another, with every register
correct and the screen black, which is what `nds-rom.test.ts` catches.

Sound is absent and named: this console's sixteen channels answer to the **ARM7
alone**, so playing them needs a driver for a second processor and a core with
two of them. A `.dmt` that names music builds, records what its rules asked for,
and plays silently — the position the Game Boy Advance was in before its ARM
driver landed. Doc 13 §D4 tracks it.
