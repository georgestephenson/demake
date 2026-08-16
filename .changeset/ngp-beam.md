---
"@demake/ngp": minor
---

Let a Neo Geo Pocket cartridge read the beam.

`RAS_H`, `RAS_V` and the status byte are the display controller _answering_
rather than memory being read back, and this core read them out of the video
region like any other address — so a cartridge polling the scanline counter got
whatever it had last written there, and a cartridge waiting on the blanking flag
waited for a frame that never came.

That was a capability `core/src/asm/ngp.ts` already documented and this core
could not honour: "reading bit 6 is how a cartridge that takes no interrupt waits
for a frame", which is `@demake/wsc`'s readable timer one console along. The
addresses come from that same declaration, so nothing here is a second opinion
about where they are.

`RAS_V` is the display's own line, the status byte's bit 6 is that line against
the first blanked one, and `RAS_H` is derived from how far into the current line
the controller has got rather than from a pixel counter nothing else would read.
Bit 7 — the per-line character overflow — stays zero, which is the honest half of
a flag rather than a wrong one: this renderer draws such a scene correctly and
has nothing to report.

`packages/ngp/test/machine.test.ts` walks a whole frame and asserts the counter
covers every line the controller has, that the flag and the counter never
disagree, and that the horizontal reading stays inside the screen.
