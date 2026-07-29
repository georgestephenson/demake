---
"@demake/audio": minor
"@demake/chip": minor
"@demake/core": minor
"@demake/demotic": minor
"@demake/md": minor
"demake": minor
---

A Mega Drive demake uses all ten of its voices.

The console has two sound chips and the engine now spends both: a YM2612 at
`$A04000` and an SN76489 at `$C00011`, arranged against as one instrument,
because that is what they are on the board. `demake arrange -c md` places parts
across six four-operator FM voices and four tone generators, `demake build -c md`
puts them in the cartridge, and the register writes both chips receive are diffed
against the schedules the demakers produced, tick for tick, with no tolerance.

**New in `@demake/chip`: the OPN2.** Six voices of four operators, eight
algorithms, the hardware's own log-sine and exponential ROM tables, envelopes with
key scaling, detune, multiple, feedback, per-voice stereo, the channel-6 DAC and
both timers — integer and table-driven throughout, so a render is reproducible
sample for sample. Three parts are stored and inert and each is recorded as a gap
rather than a decision: the LFO's pitch modulation (its amplitude modulation is
there and exact), SSG-EG, and channel 3's per-operator frequency mode.

**Timbre is searched rather than selected**, which is doc 17 §Stage 3 arriving for
the first time. Every other console in the set offers a fixed palette — a Game Boy
pulse has four duties and that is the whole choice — but an FM voice is thirty-odd
register bits. So a candidate patch is played on the chip model and _measured_,
hardware-in-the-loop on the sound demaker's precedent: where its energy sits, how
fast it arrives, how much is left after half a second. What the part asks for is
read off the source — the General MIDI family it named and the articulation it is
actually played with, because a source labelled "strings" playing staccato
sixteenths is not asking for a slow swell.

**The first console with two chips**, which generalised three seams rather than
special-casing one. `RegisterWrite` gained the `chip` field `BoundWrite` already
had, so a write says which device it addresses and `render()` filters per write
rather than per tick; `mix()` takes per-chip gains that come from the binding,
because how loud a PSG is against six FM voices is a fact about the board and a
chip model that knew which board it was on would no longer be one model; and VGM
export carries both chips in one stream, which is what that format is for.

The driver learned two things. The packed register byte, which on a one-chip
console names a register, here names one of five destinations — the FM chip's four
consecutive bus addresses or the PSG — so two chips cost the packed format
nothing. And ten voices against a four-bit channel field do not have to fit:
preemption only asks whether an _effect_ may be using a voice, so only the voices
effects were placed on are numbered, and the FM half of a track plays straight
_through_ a sound effect rather than ducking for it.

The PSG half needed no change at all: the same chip at the same master clock over
fifteen, in a frame of 262 lines of 228 chip cycles, so `mdAudio` and `smsAudio`
reduce to the same rational and `psgBinding` is called rather than reimplemented.
