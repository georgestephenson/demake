---
"@demake/core": patch
"@demake/neogeo": patch
---

Settle the Neo Geo's last two unverified descriptions. Neither changed a byte;
both changed what the code is allowed to claim.

**The `.neo` container's C interleave was convention and is now checked.** The
region is the odd/even ROM pair merged a byte at a time with the odd ROM on the
even offsets — `neosdconv` builds it as `interleave(pair, 1)` over
`[...odd, ...even]`, which is the same arrangement arrived at independently. A
wider leaf would produce a container a flash cart reads as scrambled graphics, so
it is worth knowing rather than assuming. The `.neo` header's field order and its
4096-byte length are confirmed against Terraonion's own documentation too.

**The colour word's dark bit is confirmed, and the finding justifies the console
spec rather than changing it.** Bit 15 is the "Dark bit, used as a common LSB for
the 3 components", so a channel is five bits of its own plus a sixth the three
*share*. A shared bit cannot be chosen per channel — declaring `[6, 6, 6]` would
tell the fit it can pick colours no palette word expresses — so five bits is the
*independently choosable* precision and the honest lattice. That is now stated as
a reason rather than left as a conservative guess.

`expandColor` still ignores the bit, and now says why that is a decision. Its
polarity is undocumented and the one value the hardware pins contradicts the
naive reading: `$400000` must be pure black and is written `$8000` — dark bit
set, every channel zero — which as an ordinary least significant bit would be one
step *above* black. So the sources fix the bit's position and not its sense, and
the sixth of a step it is worth is left out rather than invented, on the terms
`s-dsp.ts`'s Gaussian interpolation and the YM2612's busy flag are absent.
