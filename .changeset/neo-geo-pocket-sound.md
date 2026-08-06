---
"@demake/ngp": minor
"@demake/audio": minor
"@demake/demotic": minor
"@demake/core": minor
"@demake/web": minor
---

A Neo Geo Pocket Color cartridge plays its own music and effects.

`@demake/ngp` gains the T6W28, and `demake build -c ngpc` puts a generated
TLCS-900/H driver in the cartridge — the seventh processor to get one — so the
whole example library plays its music and effects there, diffed tick for tick by
the shared audio battery against the schedules the demakers produced.

Two things about it are this machine's and no other's in the set.

**The chip has to be asked for.** On the board the T6W28's own bus belongs to a
Z80 sound processor, and `demake build` emits no Z80 program — so the driver
writes `$55` and `$AA` to two bytes of the main CPU's own I/O page and then
reaches the chip through two more. `@demake/ngp` models the same gate, so a
cartridge that skipped them is perfect and silent rather than quietly working.

**There is nothing to merge.** The fourth console here with no shared register
and the first to have none because its hardware pans _more_: stereo is a
four-bit level inside each channel's own attenuator rather than one byte of
enables two streams both write. So no merge routine is emitted at all, and
handing a borrowed channel back replays _six_ bytes rather than three — both of
a voice's levels are things the music stated and the effect overwrote.

The deepest noise colour now writes the noise generator's **own divisor** rather
than leaving it at whatever powered up. That register is the whole of what this
part adds over an SN76489, where the same rate follows tone channel 2 and costs
a voice; here all three tones stay free.

**And a timing description was wrong and invisible.** This CPU's instruction
timings are in _states_ — the crystal halved — and the display controller counts
the crystal, so `@demake/ngp` had been drawing frames at half the hardware's
rate. Nothing could see it: a trace is per tick and a tick is per frame either
way. The audio is what made it visible, because a chip handed the wrong number of
clocks renders at the wrong speed. The whole example library still traces
identically on the corrected frame, and still at 1.00 frames per game tick.
