---
"@demake/chip": minor
---

Model the Neo Geo's SSG — the third of the YM2610's four sound sections, and the
one a demade cartridge can reach with a Z80 driver today.

Three square channels sharing a 17-bit noise generator and one hardware envelope,
which is the AY-3-8910 arrangement Yamaha kept intact when it folded that chip
into the YM2610. It sits beside `Sn76489` in the register file and is unlike it
in the three ways a driver written from that chip's habits would get wrong, so
each is pinned by a test: **volume is a level rather than an attenuation** (a
carried-over habit plays fortissimo as a whisper), **the mixer is active low** (a
set bit disables a source), and **writing the envelope shape restarts it even
when the value has not changed** — which is not a quirk to work around but the
only way a note is struck on this chip.

The pitch case is held to an outside number rather than to this file's own
arithmetic: Yamaha's manual gives the formula _and_ a worked example, A4 on period
`$238`. That is what caught `SSG_DIVIDER`. The published `250000 / period` is a
_tone_ rate and a square toggles twice a cycle, so the master-clock divider per
toggle is sixteen and not thirty-two — a model that reads exactly like the manual
and plays every note an octave low, with every register write correct. It is the
shape of failure AGENTS.md §Gotchas keeps naming, and only an external number
finds it.

The FM, ADPCM-A and ADPCM-B sections are absent rather than half-implemented, on
the terms the S-DSP's echo and the WonderSwan's Hyper Voice stage are. The
console spec declares the whole chip regardless, because a spec describes what
the hardware can do and an unmodelled section is a gap to close.
