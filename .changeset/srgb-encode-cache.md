---
"@demake/core": patch
---

Remember the sRGB encoding of a linear value, which is about a tenth of every
colour fit.

`linearToSrgb8` is one of the hottest functions in the engine — every colour a
fit snaps to the hardware lattice passes three values through it, per centroid,
per iteration, per restart, and every pixel of a picture passes three more — and
each call routes through the deterministic `pow` kernel, an eighteen-term series
over a log, to choose one of 256 answers. A flat region of a picture and a
centroid that has stopped moving ask the same question thousands of times, so
the answer is now remembered in a fixed-size direct-mapped cache. Demaking
`pong.title.svg` at each console's own screen size: NES 7.6 s → 6.4 s, Game Boy
Color 4.8 s → 4.2 s, Master System 6.2 s → 5.8 s, Mega Drive 17.9 s → 16.7 s.

**It is a cache and not a table, and that is forced rather than chosen.** The
obvious optimisation is that a monotone step function onto 256 values is 255
thresholds and a binary search — and it cannot be done, because the curve is not
monotone at the last bit: `pow` is a series rather than a correctly-rounded
operation, so around a threshold the encoded byte can step back _down_ as the
linear value rises. A table calibrated against the curve's own inverse was 581
values out of thirteen million wrong, and one calibrated ulp by ulp against the
curve itself was still nine, in both directions. What a cache remembers is the
curve's own answer for a value it has already been given, which is exact by
construction: a slot matches only on `===`.

No output byte moves. `color.test.ts` walks every threshold's floating-point
neighbourhood — the only place a disagreement can hide — and pins the
non-monotonicity too, so the next person to spot the "obvious" optimisation
finds out from a failing test rather than from a picture that demakes
differently.
