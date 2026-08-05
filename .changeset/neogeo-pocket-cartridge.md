---
"@demake/core": minor
---

Add the Neo Geo Pocket cartridge wrapper and the console's memory map.

`packNgpRom` stamps the 64-byte header the boot ROM reads and puts the program
directly after it. Four things about this cartridge are the console's own.
**There is no reset vector to chase**: the boot ROM reads an entry address out of
the header at `$20001C` and jumps to it, so the header is a region in front of
the image rather than bytes woven into it. **The recognition code is a claim, so
it is left blank** — the boot ROM checks the first 28 bytes against SNK's own
copyright or licence string, and a demade cartridge is neither, so zeroes go
there by default and an option stamps one for anyone who needs to run on the
hardware. That is the bargain `gb-cart.ts` already strikes with the Nintendo boot
logo, and it keeps the CLI's and the browser's output byte-identical by default.
**One byte decides which machine may run this** — `$00` for a cartridge a mono
Neo Geo Pocket may run and `$10` for one only the Color may, which is a Game Boy
Color cartridge's `$C0` reached by different hardware. And **there is no
checksum**, so unlike the WonderSwan's this wrapper is a function of its options
and its program rather than of the finished cartridge.

`ngpRomSize` picks the smallest of the three boards this console shipped — 4, 8
and 16 megabits — with the header counted against the program, because the
largest board is also the address space's limit.

`asm/ngp.ts` is the machine description beside it, here for `megaduck.ts`'s
reason: the core, the game backend and the audio driver will all read these
addresses, and three copies of a register number cancel each other's errors out.
Two things in it shape everything above. **The interrupt vectors are in RAM and
they are not the processor's** — the boot ROM owns the CPU's own table and
dispatches through one at `$6FB8`, so a cartridge installs a handler by writing a
pointer. And **video memory is memory**: the scroll planes, the character bank,
the object table and the palettes are ordinary addresses, so nothing is uploaded
through a port, which is the WonderSwan's arrangement reached by different
hardware.

No output bytes change: nothing yet builds through either path.
