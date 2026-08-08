---
"@demake/chip": minor
---

Model the whole YM2610 — the Neo Geo's entire sound system, fourteen voices on
one die.

Four four-operator FM channels, three squares with a shared noise generator, six
fixed-rate ADPCM sample channels and one variable-rate one. It is the widest
single chip in the package by voice count and the only one that is a synthesizer
_and_ a sample player at once.

**The FM section is a YM2612, and that is the hardware rather than a shortcut.**
The register map says so out loud: the `$30`–`$B6` block is addressed at
per-channel offsets **1 and 2** on each port with offset 0 simply absent, and the
`$28` key-on byte names the four channels `001`, `010`, `101`, `110` — which are a
six-channel part's channels 2, 3, 5 and 6 with 1 and 4 removed. The internal
sample rate agrees: 8 MHz over 144 is 55555 Hz, which is exactly the ADPCM-B
ceiling and three times the ADPCM-A rate. So `Ym2612` _is_ this section, driven at
this board's clock, and doc 16's "a chip is implemented once" arrives from an
unexpected direction — the two are not similar, they are one design. What the new
file has to do is **refuse** what the OPNB does not have: the LFO at `$22`, the DAC
at `$2A`/`$2B`, and both missing channels, because a model that plays six voices on
four-voice hardware sounds right here and silent on the board.

**The two ADPCM sections are different codecs, not one at two rates.** ADPCM-A
decodes into a twelve-bit accumulator that **wraps** — the reference decoders mask
and sign extend, so an overdriven drum folds rather than flattening, which is part
of how this console sounds. ADPCM-B decodes into a sixteen-bit one that **clamps**,
with a step size that scales by a multiplier rather than moving along a table, and
a rate that is a phase increment with no divider anywhere. A shared decoder would
be wrong in both directions at once, so the tests pin each against the other.

**One run loop over four event rates.** Box integration is only exact if the span
it is handed carries a constant level, so the loop steps to the nearest of an FM
sample, an SSG edge, an ADPCM-A sample and an ADPCM-B phase step — which is what
`Ym2612.clocksUntilSample` and `Ym2610Ssg.clocksUntilEvent` are for. The
chunk-size case proves it: the same render whatever size the caller's chunks are.

Absent and stated rather than hidden: the SSG's level against the FM half (a
_board_ question that `mix()`'s per-chip gains cannot express, because this is one
chip — `SSG_GAIN` is a named judgement instead), and ADPCM-B's interpolation
between decoded samples, on the terms the S-DSP's Gaussian window is absent.
