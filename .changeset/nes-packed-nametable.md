---
"@demake/demotic": minor
---

Pack an NES backdrop's nametable instead of storing it raw. A screenful is 960
cells and an NROM cartridge is 32 KiB, so a game with two pictures was spending
six per cent of its program on them — which is why the shooter, whose nine aliens
generate a lot of collision code, did not fit at all once it had music. A demade
screen is mostly runs, so the cells and the attribute table go in as literals and
runs and come back out through one walk with rendering off: 960 bytes becomes
279–682.

The example library gains 280–560 bytes per picture. The shooter gains about 940,
which takes it from over the cartridge to 528 bytes free with its theme and its
four effects — so it joins the sweep in `audio.test.ts` rather than having its
overflow asserted, at the same 512-byte floor the Game Boy Color build carries and
for the same kind of measured reason.

What is guaranteed is the bytes that reach the PPU, not the encoding, so the test
boots the cartridge and reads the PPU's own memory rather than checking the
format.

NES cartridge bytes change.
