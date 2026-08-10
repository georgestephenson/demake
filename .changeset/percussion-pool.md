---
"@demake/audio": minor
---

Give a percussion part every dedicated drum voice the console has — the second
A5.5 line closed (doc 13 §A5.5).

A General MIDI drum track is **one part**, and `plan.ts` gave one part one
channel. So a Neo Geo, whose YM2610 has six ADPCM-A voices playing real
recordings of drums, played its whole kit on one of them and left five idle —
and worse than idle: every hit that landed while another was still ringing was
dropped. The example library's overworld theme writes 96 drum notes and the
cartridge played 64. Nothing before that console had more than one percussion
voice, so the question had never come up.

A percussion part now takes a **pool**, and all 96 play. Three decisions shape
it:

- **By drum class, not round-robin over arrivals.** A kick that is still ringing
  is never cut off by the hat on the next eighth, because they are not on the
  same voice. Round-robin would put consecutive kicks on different voices, and
  for _recordings_ that is flanging rather than depth.
- **The two hats share a voice on purpose**, because a closed hat choking a
  ringing open one is what the pedal on a real kit does. Getting it out of the
  allocation is worth more than giving each its own.
- **Dedicated drum hardware only** — a noise generator or a fixed-rate sample
  voice, the ones `affinity` scores at zero. An FM voice will host a kit and is
  offered at 6, but handing it every spare one would take six four-operator
  voices and six fitted patches for material a single noise generator serves.
  `interchangeable` draws the same line inside one `kind`: a YM2610's ADPCM-B is
  a `sample` voice like its ADPCM-A voices and the only one with a pitch, so
  pooling it into the kit denied the arrangement its one pitched sample voice.

Output bytes change on the three consoles with spare percussion hardware — the
Neo Geo, the Nintendo DS (two noise generators) and the Game Boy Advance (its
APU's noise channel beside the mixer's recording of one). Every other console
has exactly one, where the pool is a pool of one and the schedule is byte-identical.

Not fixed, and recorded in doc 13: a hit dropped for colliding with a ringing one
is still not counted anywhere, which "never lose a part silently" forbids.
Reporting it reaches `--strict`, which turns any drop into an error — so whether
a choked hi-hat is a failure or an `info` the way a merged voice is needs
deciding first.
