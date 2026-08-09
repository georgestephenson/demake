---
"@demake/demotic": patch
---

Add the Neo Geo's rendering oracle, and fix the palette bug it found.

Trace conformance is `rom.test.ts`'s; this is the file for the things a trace
cannot see, and every case is one this hardware alone can get wrong — the plane
being a sticky chain rather than twenty-one strips stacked on the same sixteen
pixels, sprite 0 left to the hardware, the fix layer's column-major addressing,
the font's palette surviving the fit, and the `.neo` container's C ROM pair
decoding back to what the art path made.

**It immediately found a real defect**, which is the argument for writing it.
`packPalette` wrote the font's ramp from entry zero — and palette zero's entry
zero is `$400000`, which the hardware requires to be pure black because the video
output uses it as its reference. An ordinary encoded black is a different word,
and nothing else in the project could have noticed: a trace says nothing about
colour, and the fit was internally consistent.

Two cases are `it.todo` and say why. Objects and captions are staged by
`emitObjects` and `PokeFix`, and both routines are reached — the VRAM address
port is left pointing inside the fix map, so the addressing is running — but the
words that arrive are zero. That is exactly the class of bug this file exists for
and exactly the class a trace cannot report, because an object's _position_ is
state and its _drawing_ is not. Recorded rather than deleted, so the gap is
visible and the cases are ready when the value is.
