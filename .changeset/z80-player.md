---
"@demake/audio": patch
---

Move the Z80 stream player out of the Sega's driver and into the processor's own
file, on `mos-player.ts`'s terms: a second console started driving one, and the
walk over packed data belongs to the **CPU** rather than to either machine.

What a chip decides is now two hooks — how one packed write leaves the CPU, and
how a borrowed channel's byte reaches a shadow — because those are the only two
places an SN76489 on a Sega 8-bit and a YM2610 on a Neo Geo disagree. The first
is one port and a store; the second is four ports with a settling time between
them, which is a difference that shows up on hardware and never in an emulator.

`sms-driver.ts` is what an SN76489 on this CPU owns and is now those two hooks
and its port numbers. No cartridge changes by a byte: `demake build -c sms`
produces the same 32 KiB it did before the move.
