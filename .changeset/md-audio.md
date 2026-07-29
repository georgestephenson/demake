---
"@demake/audio": minor
"@demake/core": minor
"@demake/demotic": minor
"@demake/md": minor
"demake": minor
---

A Mega Drive cartridge plays its music and its effects.

`demake build -c md` now demakes a game's `.mid` and `.wav` files with the same
audio engine every other console uses and plays them from a **generated 68000
driver**. The whole example library boots in `@demake/md` and the register writes
its PSG receives are diffed against the schedules the demakers produced, tick for
tick, with no tolerance — the same battery the Game Boy, the NES and the Sega
8-bits run (`packages/demotic/test/audio.test.ts`). The page plays it too, so the
sound button is no longer withheld on any console with a backend.

The chip is a Master System's, and not merely by resemblance: an SN76489 at
`$C00011`, fed by the same master clock divided by fifteen, in a frame of 262
lines of 228 chip cycles — so `mdAudio` and `smsAudio` reduce to the same
rational and the existing register encoder needed no change at all.
`demake arrange`, `demake sfx` and `demake render` therefore accept `-c md` as
well.

What is genuinely this processor's is small, and all of it makes the player
shorter: a `move` sets the flags, so one instruction answers both of the packed
dispatch's questions where the Z80 needs `or a` and then `bit 7,a`; a stream
pointer is a longword, because the packed data is anywhere in half a megabyte;
and the chip is an address rather than a port, held in an address register across
the write loop.

The fourth driver is where the duplication came out. Everything the _chip_
decides — the latched channel tag, the latch discipline preemption rests on, what
silencing a channel means — is now `rom/psg.ts`, shared by the two processors
that drive an SN76489. Everything every driver does to a schedule before a CPU
sees it — the boot-prefix strip, the channel restriction, the union of what a
player must cope with — is now `rom/shared.ts`. No console's output bytes moved:
the bodies were already identical.

`@demake/md` grows a `@demake/chip` dependency and models the PSG rather than
dropping writes to it, with the `psgTap` and `audioSink` the other cores have.
The YM2612 is still not emitted, and the console spec deliberately does not name
it: an `AudioSpec` is the contract the demakers arrange _against_, so a chip with
no model and no binding would be a promise the arranger cannot keep. Six FM
voices are what this console's spec gains the day `@demake/chip` can play them.
