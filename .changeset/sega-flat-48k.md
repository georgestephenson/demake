---
"@demake/core": minor
"@demake/demotic": minor
---

A Sega cartridge grows to 48 KiB when a game needs it, with no bank switching.

Forty-eight kilobytes is flat address space on this hardware, which looks like it
should not be. The mapper is in the cartridge rather than the console, and it
comes up with slot 0 holding bank 0, slot 1 bank 1 and slot 2 bank 2 — so
`$0000`–`$BFFF` is already mapped and a program that never writes a bank register
sees one continuous image. Work RAM starts at `$C000`, which is where the flat
image has to stop.

`packSegaRom` now accepts either flat size and takes the `TMR SEGA` size nibble
from the image, so a 48 KiB cartridge cannot describe itself as a 32 KiB one. The
backend assembles the small cartridge first and only reassembles when the game
does not fit, which is why **every existing Sega cartridge is byte-identical** —
`caves`, `shooter`, `platformer` and `breakout` all hash the same as before.

`sms-flat48.test.ts` is the part that makes this a claim rather than arithmetic:
it builds a game into 48 KiB, checks the size nibble, checks the header hole is
padded across rather than written over, boots the cartridge in `@demake/sms` and
diffs it against the reference interpreter tick for tick. The game is generated,
because no example lands in the window — the library's biggest Sega build is
29 KiB and the one that does not fit needs 118.

**And a Mega Drive picks its board.** `MD_ROM_SIZES` is 512 KiB through 4 MiB
and the build takes the smallest that fits, which needs no mapper at all — the
console maps the whole cartridge from `$000000` and the header records where it
ends, so growing one is a bigger array and a different number at `$1A4`. Half a
megabyte stays the floor, so every Mega Drive cartridge built before this is
byte-identical (`quest`, `caves` and `shooter` all hash the same), and a game that
outgrows it pads to the next power of two instead of failing. Past 4 MiB it needs
paging through `$A130F1`, and says so.

**What the Sega 8-bit change does not reach.** The header is sixteen bytes _inside_ the image at
`$7FF0`, so a 48 KiB build pads across the hole and the data section starts at
`$8000` — the gap between the end of the code and `$7FF0` is wasted. The window
is therefore games whose _code_ ends just below the header; past that there is
nowhere to put the header at all, and the build says so by name rather than
failing in the assembler. Doc 13 §Banked cartridges records both the fix (place
the hole tightly, or use one of the other header slots the BIOS accepts) and why
it wants doing before slot-2 paging, which inherits the same hole.
