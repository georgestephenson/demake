---
"@demake/core": minor
"@demake/audio": minor
"@demake/ngp": minor
---

Correct the Neo Geo Pocket's four sound port addresses.

`NGP_SOUND_RIGHT`, `NGP_SOUND_LEFT`, the two bytes that hand the chip to the
main CPU and the two DAC ports were all recorded sixteen bytes low: `$20`,
`$21`, `$38`, `$39`, `$22` and `$23` against the hardware's `$A0`, `$A1`, `$B8`,
`$B9`, `$A2` and `$A3`. They come from MAME's `ngp.cpp`, whose I/O handler is
**installed** at `$80`-`$BF` and indexes from there — so its `case 0x20:` is a
map offset and not an address. beetle-ngp decodes the same ports absolutely and
agrees.

**Nothing could see it**, which is why it survived: `@demake/ngp` read the same
four addresses `@demake/audio`'s driver wrote, so a demade cartridge wrote where
a demade emulator read and the whole in-game audio battery passed on a pair of
ports no Neo Geo Pocket has. It surfaced only when the processor's own timer
block was described, because `TRUN` really is at `$20` — which read as a
collision between two cited sources rather than as an error in one of them.

**This changes bytes.** Every Neo Geo Pocket Color cartridge `demake build`
produces now writes its sound to `$A0`/`$A1` and unlocks the chip at
`$B8`/`$B9`. The game plays identically — a trace says nothing about registers —
and the audio a real console would produce goes from nothing to the schedule.
