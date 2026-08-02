---
"@demake/audio": minor
---

`demake arrange -c gba`, `sfx -c gba` and `render -c gba` demake audio for the
Game Boy Advance's ten voices.

The second two-chip binding, and the first whose two chips are different _kinds_
of thing: four Game Boy channels that generate their own waveform, and a
software mixer that plays samples. The Game Boy half is `gb.ts` _called_ rather
than restated — the same encoder, the same envelopes, the same `NR51`, at
addresses that are the machine's business and not the binding's — because a
second copy is how two consoles quietly stop agreeing about what a demade pulse
sounds like.

The mixer half has no shared register worth merging. A voice's source, step and
two levels are its own five bytes; the one byte two streams could both want is
`KON`, and it is a _pulse_, so a driver masks it to what the stream still owns
rather than folding two shadows. Level is a per-side byte, so panning and
dynamics are one write and a note costs two bytes a tick rather than ten.

`gba-bank.ts` is the waveform bank, and it is not the Super Nintendo's copied.
A cycle is thirty-two samples rather than sixteen, chosen against the lattice so
the whole melodic range stays inside a step the model interpolates across rather
than skips over. And **noise is a sample**, because a mixer has no noise
generator: percussion plays a 4096-sample recording of the Game Boy's own shift
register, which is why the spec declares one noise period rather than sixteen.

**The artifact for this console is a WAV**, which is new. VGM is a write log, so
it is right wherever the schedule is one; a Super Nintendo schedule is an `.spc`
because a write log without its sample RAM is not music; and half of a Game Boy
Advance schedule addresses a software mixer whose register file is demake's own,
which no container knows and none could usefully learn. A VGM carrying only the
four Game Boy channels would be a schedule with two thirds of the music missing,
presented as the schedule. `artifactFormat` now takes the whole chip list rather
than the first of it, because that is the question: a console is its board.

Still to come on this machine: the ARM driver that would play any of it from
inside a cartridge. The support matrix says so — it asks the driver table, not
the spec. The web app's audio sections also still name every artifact `.vgm`,
which is right for eight consoles and wrong for two; correcting it means the
worker handing the page the extension alongside the bytes, because deciding it
in the page would be a second implementation of `artifactFormat` (doc 07 §The
web app must never grow conversion logic).
