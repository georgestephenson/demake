---
"@demake/demotic": minor
---

Page a PC Engine cartridge's tick steps, so `quest` builds there

The seventh console family to page, and the one whose mapper costs least. A game
that outgrows the 48 KiB window now takes a bigger HuCard and pages `$4000`–
`$7FFF`, on the Sega's unit: one step of one tick, plus each scene's reset,
camera and render. `quest` builds on a 256 KiB board and `rom.test.ts` traces it
against the interpreter tick for tick.

**The mapper is in the CPU**, so a bank switch is `lda` and `tam` — against
MMC1's five serial stores and MBC5's store-plus-shadow. The window is two of this
mapper's pages because one is eight kilobytes and a tick's largest step is ten,
and `tam` sets every register its mask names to the _same_ bank, so it is two
pairs rather than one instruction with two bits in it.

What stays mapped is `$8000`–`$FFFF`: twenty-four kilobytes of program and the
boot bank above it. That is not enough for a game's data as well, so the
character bank and the packed schedules are paged units — the Game Boy's two,
minus the third, because this console's instance defaults are small enough to
stay. Both cost one `enter` and no more: the characters are streamed into video
RAM by the boot and never read again, and the schedules are read by
`AudioService`, which this console runs from the _main loop_ rather than from the
interrupt that counts its ticks — so unlike a Game Boy's there is no bank to save
and put back.

Every cartridge that fitted the flat window is byte-identical.
