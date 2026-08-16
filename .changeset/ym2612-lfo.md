---
"@demake/audio": minor
---

Spend the YM2612's LFO for vibrato, so the Mega Drive stops paying per-tick pitch
writes for it — the binding half of doc 13 §A5.5's first line.

Vibrato was written rather than switched on everywhere, which costs two to five
times a dry track's register writes on a track of held notes. A YM2612 has an LFO
whose setting 1 is **5.56 Hz**, within a tenth of a hertz of the rate the arranger
states — so `binding/md.ts` declares its six FM voices in
`ChipBinding.lfoChannels`, `compile.ts` leaves their pitch as written and states a
depth in `ChannelFrame.vibrato`, and the binding programs `$22` and the
sensitivity nibble in `$B4`. Measured on a track of held notes with the wheel at
full: **+122% over dry becomes +4%**.

Three things about the seam:

- `lfoChannels` belongs to the **binding**, not to `AudioSpec`, because what it
  answers is "will this encoder do it in hardware" — a question about the register
  map, which is exactly what a binding is the only place to know.
- The **delay applies to both routes**, so a chip that bends itself starts when
  one bent by the driver would. Otherwise the same note starts vibrating at
  different moments depending on the console.
- `$22` is written **lazily**, on the first tick anything asks for vibrato, so a
  track with no modulation writes exactly the registers it always did — which is
  every MIDI in the example library, verified byte for byte on all twelve consoles.

**The Neo Geo is deliberately excluded, and this is the interesting part.** An
OPNB is an OPN2 with the LFO _removed_: `ym2610.ts` refuses `$22` by design,
because routing it through would offer a binding hardware the console does not
own. It was wired up there first, and the failure is the worst kind — the binding
stops the per-tick pitch writes, the chip ignores the registers, and the note comes
out straight with nothing anywhere reporting a problem. The chip model's own
refusal is what caught it. That console keeps paying the per-tick price (+154%),
and `vibrato.test.ts` holds both halves: no LFO programmed there, _and_ the pitch
still moving.

The HuC6280's LFO stays unspent and that is a refusal rather than a gap: channel
two _is_ the modulator on that chip, so vibrato would cost a whole voice to
modulate one other — spending the machine downwards on a six-voice console.

No existing output moves.
