---
"@demake/audio": minor
"@demake/chip": minor
---

Demake music and sound for the Neo Geo — `arrange`, `sfx` and `render` now target
its fourteen voices, and the console is the seventeenth in the matrix.

**The FM half is the Mega Drive's, and that is the hardware.** OPNB and OPN2 are
one FM core, so `patchWrites`, `pitchWrites` and the key-on encoding are called
rather than restated. What this console supplies is a channel map and a clock, and
the map is not a convention anybody chose: `FM_SLOT` is `[1, 2, 4, 5]` because
those are the four OPN channels this part wires out, and running them through the
shared encoding reproduces exactly the `001`, `010`, `101`, `110` key-on codes the
hardware documentation lists. A map that had to be corrected afterwards would have
meant the two chips were merely similar.

**A second FM console found a hardcoded first one.** The arranger named
`mdBinding` outright for any console with FM voices — so the Neo Geo was encoded
as six FM channels and an SN76489, which disqualified every candidate with a byte
that was not one. Which binding a console gets is `bindingFor`'s answer alone now,
and fitted patches reach it through the registry. No existing console's schedule
changes: the Mega Drive resolves to the same binding it always did.

**This console has no shared register, for two reasons at once.** The SSG mixer is
the one byte three channels share and it is written once at boot — tone on, noise
off — because a note is silenced by its own level; and the ADPCM key-on byte is a
_pulse_, acting on the voices its mask names and leaving the rest alone, which is
the Super Nintendo's `KON` on completely different hardware. So no merge routine
is emitted at all, and the sixth console to say that says it for new reasons.

**The percussion is a recording.** `binding/neogeo-bank.ts` is the fourth kind of
bank in the set and the first that is _two_ ROMs in two codecs: ADPCM-A drums
chosen by the pitch `compile.ts` gives a hit, and ADPCM-B single-cycle waveforms
for the one sample voice that has a pitch. Both encoders run the decoders' own
arithmetic — the twelve-bit wrap for A, the sixteen-bit clamp and multiplicative
step for B — because that is the only way a search over sixteen codes lands on
what was intended. The planner learned to match: a sample voice is the best
percussion channel there is, and melodic only where the hardware gave it a lattice.

The chip model gained `SAMPLE_GAIN`, which is its sample section normalising by its
own seven voices exactly as the FM core normalises by six — without it one drum is
six times an FM voice and every demake clips the moment a kick lands. The VGM
writer gained the chip's two commands and, more importantly, its two sample ROMs
as data blocks: a Neo Geo track without them plays its FM and its squares and has
no drums, which sounds like an arrangement decision rather than a missing file.
