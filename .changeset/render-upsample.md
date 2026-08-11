---
"@demake/chip": minor
---

Render a chip that clocks below the output rate — `demake render -c gba` wrote an
all-`NaN` WAV, and had since that console was added.

`renderSchedule` box-integrates a chip's output with boundaries at
`floor(i × clockHz / sampleRate)`. Almost every model here clocks in megahertz,
so a box is thousands of clocks wide and integration is plainly a downsample. One
is not: `GbaPcm` is a **mixer** rather than an oscillator and runs at 32768 Hz,
below the 48 kHz a render defaults to. Consecutive boundaries collide, the box has
zero width, and the mean of no clocks is `0 / 0` — so every sample after the first
was `NaN`.

The fix needed no new mechanism, which is the argument for it. When the output
rate is above the chip's, a sample's box falls **entirely inside one clock**, and
the mean of a constant is that constant. Holding the value is not a fallback for a
degenerate case; it is what box integration already meant when the box is narrower
than a clock, so upsampling and downsampling stay one rule.

The trap is the accumulator: clearing it on a zero-width box throws away clocks
that belong to the box after it, rendering every second sample as silence. That is
a far quieter failure than the `NaN` it replaces and no check for `NaN` would
notice it. `packages/chip/test/mix.test.ts` pins both, and its sharp assertion
needs no tolerance argument — a constant rendered through a slow clock and a fast
one must produce the _same samples_, because the mean of a constant does not
depend on how the boxes fall.

Only the Game Boy Advance's rendered audio changes, and it changes from `NaN` to
audio; every other console's render is byte-identical, verified by hashing all
twelve. No register schedule moves — the bug was in the renderer, not in any
binding, which is why `audio-gba.test.ts`'s byte-for-byte mixer proof kept passing
throughout: it compares the driver against the model's own integer mix rather than
against a float render.
