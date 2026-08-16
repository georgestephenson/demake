---
"@demake/audio": minor
---

Produce tremolo from the source's controller 92, and spend the YM2612's other
LFO output on it (doc 13 §A5.5).

A YM2612 has one oscillator and two things come off it. The pitch half landed
earlier; this is the amplitude half, read on exactly the same terms — General
MIDI puts tremolo depth on controller 92, so `score/midi.ts` keeps that one
beside the modulation wheel and `Note.tremolo` carries it, per note, taking the
highest the controller reached while the note sounded.

Three things about it are the hardware's rather than vibrato's restated.

**It is an attenuation, not a swing.** This chip's LFO only ever _adds_
attenuation, so a note peaks at the level it was given and dips up to
`TREMOLO_MAX_DB` below it — and the software route is written to match, or the
console without the hardware would be the louder of the two.

**The rate and the delay are the same constants**, named in `vibrato.ts` rather
than duplicated: one oscillator drives both, so a track whose tremolo ran at a
different speed from its vibrato could not be played on the console that has the
hardware for either, and `binding/md.ts` would have to choose which to honour.

**The depth is two bits against the pitch sweep's three** — 1.4, 5.9 and 11.8 dB
— so a tremolo here is the coarser of the two controls, which is the hardware
rather than the demaker being vague.

The per-operator enable is the part with a trap in it. AM is switched on per
_operator_ and only the **carriers** get it, since AM on a modulator moves the
timbre rather than the level — and it cannot be left set, because the chip parks
its amplitude sweep at the _quiet_ end while the LFO is off, so an operator
carrying the bit through a dry passage is permanently attenuated. `$60`'s datum
is therefore one function with two callers: the patch install states it, and
`amWrites` restates just the carriers' bytes when only the modulation changed —
eight bus writes against a patch's fifty.

Measured on `rally.mid` with the controller on its lead, the Mega Drive pays
3.3% more writes where a Game Boy pays a volume write a tick. Nothing in the
example library touches controller 92, so this closed a line and re-baselined
nothing.

It also fixed a latent bug in the pitch half that nothing could reach before:
the engage gate asked `vibratoElapsed`, which answers `null` when a note has no
vibrato — so a note that asked only for tremolo would never have engaged either.
The delay is one question about a note now (`modulationElapsed`) and each
modulation gates on its own depth.
