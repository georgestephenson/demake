---
"@demake/core": minor
"@demake/demotic": minor
---

Page a Sega cartridge's scenes, so `quest` builds on both 8-bit Segas.

This console's window is sixteen kilobytes and `quest`'s largest scene is
twenty-six, so unlike the Super Nintendo it cannot take a scene per bank. The
unit is a **tick step**: a scene's tick becomes a run of calls in the fixed half
that pages each of its seven steps in turn, plus its reset, camera and render.
Nine and a half kilobytes is the largest piece the example library produces, and
a step that will not fit a window is refused by name.

What makes it cheap is where the split falls. Slots 0 and 1 come up holding banks
0 and 1 and a demade cartridge never moves them, so **32 KiB is fixed** and holds
everything that cannot be paged: the boot, the interrupt vectors, the shared
helpers, the audio driver _and its schedules_ — an interrupt enters it, so it has
to be mapped whatever the game was doing — the level tables, the instance
defaults and every other table an always-mapped address reaches. The tile art
goes in the window instead, because the boot uploads it once and nothing reads it
again.

Three things follow. **Nothing saves or restores the bank**: only the fixed half
enters a paged routine, and only a paged routine cares what the window holds.
**A paged routine calls and reads downwards** — a helper and every table are at
`$0000`–`$7FFF` — so not one byte of the value layer, the rule bodies or the tile
walk changed. And **the header hole is where it was**, at `$7FF0` in the fixed
half, already stepped over a block at a time.

`SMS_ROM_SIZES` now runs 32 KiB to 512 KiB and the build takes the smallest board
that holds the banks it opened; `packSegaRom` stamps any of them, and the size
nibble is a lookup because the codes _wrap_ — `$F` is 128 KiB and `$0` is 256.
`AsmZ80.section` moves no bytes, so the emitter can put the paged banks first and
the fixed half last (helpers are pulled by whatever calls them, so `ctx.finish()`
has to run after all of it) and `sms.ts` copies each bank into place.

`@demake/sms` needed no change at all: it already decoded `$FFFC`–`$FFFF` out of
the RAM mirror and paged all three slots.

Every Sega cartridge that fitted a flat board before is byte-identical — checked
by building `caves`, `shooter` and `runner` against the previous commit — because
a game that fits pages nothing and its tick stays one run of code.
