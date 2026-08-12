---
"@demake/vb": minor
---

Give the Virtual Boy core its sound processor.

The VSU was a register page that accepted every write and generated nothing,
which is the one shape of absence a register diff cannot tell from a chip. It is
`@demake/chip`'s `Vsu` now — the same model the schedules are fitted against,
not a second copy — advanced by the same crystal the processor counts, at a
quarter of it: twenty megahertz over four is exactly the five the chip model
states, so nothing about this console's audio rounds.

`vsuTap` is the window doc 16's Level A proof will read through, reporting the
**byte offset from the chip's base**, which is what a schedule's register number
is on this console — the waveform tables, the modulation table and the six
channel blocks are one address space rather than a port and an index.

Two things about the wiring are this console's. The register page answers
**zero** when read rather than the byte last written, because nothing on this
chip reads back and a shadow kept to read would be a second model of it. And the
chip is advanced only when a sink is attached, which is safe here for the reason
it is not on a Mega Drive: there is no status byte and no timer, so a cartridge
cannot tell whether it ran.

This is the half of the Virtual Boy's in-game audio driver that is not the
driver. What remains is a V810 stream player, which would be that processor's
first.
