---
"@demake/web": minor
---

Play Sega cartridges in the page, and build them off the UI thread. The game
section's console selector now changes the cartridge for the Master System and
the Game Gear as well: the browser compiles the `.dmt` to Z80, demakes its art
into sixteen-colour tiles and boots the result in `@demake/sms`, with the bytes
pinned byte-identical to `demake build -c sms` by the determinism spec. Which of
the two machines it comes up as is the cartridge's own region nibble, the same
rule the Game Boy family runs under. The sound button is disabled there, and the
pane says why: the SN76489 driver is not written yet, and a switch that turns on
nothing is worse than one that is plainly unavailable.

The cartridge is now built in the engine worker rather than on the UI thread.
That is where every path that touches `@demake/core` already belonged — a game's
art is demade by the same engine, so the build was seconds of arithmetic during
which nothing repainted — and it is also what paid for the third console: the
image engine and the audio demakers were being bundled twice, once per thread
that wanted them, and the whole site's JavaScript drops by about 25 KB gzipped
with the second copy gone. The tab no longer stops at all while a colour backdrop
is fitted.
