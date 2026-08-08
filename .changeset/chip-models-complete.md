---
"@demake/chip": minor
---

Every sound chip models the whole of its hardware.

Six things across three chips were **stored and inert** — the register was kept
rather than dropped, and nothing was done with it. Each was recorded as a gap
rather than a decision, on the rule that a `ConsoleSpec` describes what the
hardware can do and a chip with a gap in it is a gap to close. They are closed.

None of the six is reachable through a register any binding in this repository
writes, so **no demake's audio changes by a byte**: `md.ts` writes `$22` once
with the LFO off and never touches `$90`, `$A8` or `$27`'s top two bits, and
neither the PC Engine's nor the WonderSwan's binding writes their console's. That
is the point of doing this before a binding wants any of it — a binding reaching
for one now gets the hardware rather than a shrug.

**The YM2612's three.** _Pitch modulation_ is applied to the F-number rather
than to the phase increment, summed over the F-number's own bits — which is what
makes one depth the same interval in every octave instead of the same number of
hertz, and the reason it is a 128 × 8 × 32 table rather than a multiply. _SSG-EG_
runs the envelope four times as fast and stops it at half attenuation, then holds
it, folds it or takes the attack again depending on the mode's low three bits;
the fold is a _reading_ of the envelope rather than a change to it, so the
counter keeps counting either way and two inversions cancel. And _channel 3 can
hold four pitches_, which are not in slot order: `$A9`, `$AA`, `$A8` and the
channel's own feed S1 to S4, with a latch of their own so a driver may leave the
shared one half-written. The timer-driven key-on that rides on the same mode bits
came with it, which is the one place on this chip where a note begins with no
key-on write at all.

**The HuC6280 PSG's LFO**, and it is unlike every other vibrato in the package
because there is no oscillator: channel two _is_ the modulator. Its waveform, at
its own divider slowed by the whole of `$08`, is added to channel one's divider —
so switching the LFO on costs a _voice_, the shape of the sweep is whatever a
driver uploaded into that channel, and the depth is a shift on the **divider**
rather than on the pitch, which makes one setting a wider interval on a low note
than on a high one. Bit 7 _halts_ the modulator where it stands rather than
switching it off, which holds the carrier at a detune instead of returning it.

**The WonderSwan's PCM voice.** `$90` bit 5 turns channel two into a direct D/A:
`$89` stops being two volume nibbles and becomes an eight-bit sample the chip
holds until the next write, and `$94` supplies the only level it has — full, half
or silent, per side, with the pair read as two flags rather than as a number. So
that hardware can play a recording on one of its four voices, and it costs a
channel rather than adding one.

What remains in these three models is stated where it lives and none of it is a
register being disbelieved: the OPN2's bus busy flag (always clear, which is the
honest answer for a model with no bus timing) and the discrete-versus-ASIC
operator quantisation (a difference between two _boards_); the WonderSwan Color's
Hyper Voice stage, which is on ports of its own, and its readable output
registers, which no reference this project could reach describes. Two of the six
also leave work _above_ the chip layer rather than in it — nothing yet streams
samples into the PC Engine's direct D/A or the WonderSwan's voice, which is a
demaker's job and not a model's.
