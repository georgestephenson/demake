---
"@demake/demotic": minor
"@demake/core": minor
---

Page a Game Boy cartridge's tick steps, so `quest` builds there

A game that outgrows a mapper-less 32 KiB now takes an MBC5 cartridge and pages
its scenes through `$4000`, on the Sega 8-bits' unit: one step of one tick, plus
each scene's reset, camera and render. `quest` builds and plays on all three
machines in the family — Game Boy, Game Boy Color and Mega Duck — at 128 KiB, and
`rom.test.ts` traces it against the interpreter tick for tick.

What is this console's rather than the Sega's is the **fixed bank**: sixteen
kilobytes against that machine's thirty-two, so three blocks of data are paged
units as well. The tile art goes up because the boot uploads it once; the packed
audio schedules go up because they are the biggest single item; and the instance
defaults go up in _two_ copies, because the boot restore wants every entity's at
once and each scene's reset — itself a paged routine — wants its own and cannot
read a table in another bank.

The audio driver is entered by a timer interrupt, so it saves the running bank,
maps the schedules', ticks, and puts the old one back — read out of a RAM shadow,
because MBC5's bank register cannot be. `rom.test.ts`'s case is handed the game's
audio so that there is an interrupt to arrive at all, and `_audio-battery.ts`
diffs a schedule read through the window against the demaker's, tick for tick.

Every cartridge that fitted 32 KiB before is byte-identical.
