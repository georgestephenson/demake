---
"demake": patch
---

Render the boot in Level B, and record what that uncovered.

`packages/cli/test/audio-level-b.e2e.test.ts` compared a core's samples with
`render(built.performed)` — the schedule with its boot prefix removed. That is
the right comparand for Level A, where a capture begins at the first tick and
diffing against the caller's copy would ask the driver for writes it correctly
made earlier. It is the wrong one for a render: those writes are chip **state**,
and a render that never performs them plays something else.

On four of the five families it changes nothing at all — their boot is a handful
of latches the schedule's own tick 0 repeats, so `stripBoot` removes nothing and
the two renders are sample-identical, the NES included at 0.9992 either way. On
the two whose boot carries **waveforms** it is the difference between the track
and silence: a PC Engine render loses 37% of its level (0.0905 RMS against
0.1431) and a WonderSwan's loses all four pitched channels, because that chip
reads its tables from an address the stripped schedule never states. The PC
Engine row had been shipping against a render with no wave RAM in it.

No test output changes on the four rows in the table; the fix is to what the
fifth would have measured.

**And the WonderSwan's own number is now diagnosed rather than open.** It scores
0.9038 rendered properly against 0.6469 before, which is still under the gate —
and the residual is one channel. Dropping the drum part from the arrangement
takes the same tune, in the same core, to **0.9978**. Pointed at one held note at
a time the two models agree to the hertz on every pitched voice (441 Hz against
441, 215 against 215); pointed at the noise voice alone they do not, ours peaking
at 1497 Hz where the core peaks at 140. So what is open is a disagreement between
`@demake/chip`'s `WsSound` and Mednafen's about one generator, and settling it
wants a hardware reference rather than a threshold. Docs 13 §A2.5 and 16 §The
proof carry the measurements.
