---
"@demake/audio": minor
---

Build Level B — our chip models against a third-party core's actual samples.

Level A diffs the register writes exactly: a standalone audio cartridge boots in
a core we own and every write is compared with the `ChipScript`, tick for tick,
with no tolerance. What it cannot see is the half below the registers — whether
our _model of the chip_ turns those writes into the same sound. A duty table off
by one, a noise polynomial with the wrong tap, a volume law that is linear where
the hardware is logarithmic: each produces a perfect register stream and the
wrong audio.

`emu-harness/libretro/retrorun.c` now captures its audio callback and writes a WAV
at the core's own rate, opt-in through the same `key=value` channel core options
use — so a capture that only wants pixels is unchanged and every existing caller
keeps working. `packages/cli/test/audio-level-b.e2e.test.ts` boots the cartridge
in a third-party core and compares what comes out with `render()`'s output from
the same schedule.

**The comparison is spectral, and that was measured rather than assumed.** A
waveform diff was tried first and is not available: against fceumm the level
differs by 19%, and cross-correlation locks onto the music's own periodicity
rather than the true alignment — the best lag wanders between 899 and 4456
samples across one capture, which is a flaky test rather than a strict one. The
long-term average magnitude spectrum is blind to phase, alignment and a constant
gain, and is exactly what a wrong chip model moves.

**The threshold is 0.99 because a mutated chip model scores 0.9801.** That row is
not a constructed comparison: it is `nes-apu.ts` with `ch.duty = v >> 6` changed
to `(v >> 6) ^ 1`, which keeps Level A entirely green and is precisely the bug
this level exists to catch.

| compared with the core                | similarity |
| ------------------------------------- | ---------- |
| our render of the same schedule       | **0.9992** |
| the APU with its duty bit inverted    | 0.9801     |
| the same tune arranged for a Game Boy | 0.9492     |
| our render, 6% sharp                  | 0.8826     |
| white noise                           | 0.4236     |

A `discriminates` case keeps that honest inside the suite, asserting the Game Boy
comparison fails the same gate through the same code path.

A console qualifies when it has **both** a standalone audio cartridge and a
libretro core — the NES, both Sega 8-bits, the Mega Drive and the PC Engine —
and each joins by appearing in one table. The suite self-skips per console, so a
machine with one core provisioned runs that one.

Also fixes a staleness bug in `install-libretro.sh`: the runner was only compiled
as a side effect of building a core, so editing `retrorun.c` on a warm cache left
the old binary in place and the change simply did not take. The header is cached
alongside it now and the runner rebuilds when its source is newer.
