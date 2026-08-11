---
"@demake/audio": minor
---

Stop restarting the Game Boy's waveform when a note is only bent.

`NR34`'s bit 7 is a trigger, and on the wave channel a trigger does something
the other three do not: it resets the **wave position** to zero. The binding
carried that bit on every pitch write, so any pitch change while a note was
sounding restarted the waveform — audible as a click rather than as a wrong
note, which is exactly the class of defect doc 16's Level A cannot see. The
schedule is performed faithfully, every register diff stays green on every
console, and the cartridge sounds wrong.

`encodeNoise` in the same file already guards the identical hazard one channel
along — "writing every tick would restart the shift register and turn a ringing
snare into a buzz" — so this is that rule stated for the channel where the state
being restarted is a position.

**It was live in the example library.** Two things reach a mid-note pitch
change, and one of them needed no new feature: the wave channel plays whichever
note of a sustained chord the arranger chose, and that choice can move while the
chord is still sounding. `keep.mid` restarted the waveform 47 times that way and
`vault.mid` 11. The other is vibrato, which is several bends a second for as long
as a note is held.

Measured on the wave channel alone, `keep.mid` goes from 85 sample-to-sample
discontinuities to 68, with a peak difference between the two renders of 0.48 of
full scale.

`packages/audio/test/gb-wave.test.ts` holds both halves — the byte, and the
audio. The second is a mutation: it puts the bit back and asserts the render gets
worse by a measure taken from the samples, so a fix that only changed the write
would not pass. The note it measures is driven through the binding by hand rather
than arranged, because which channel a fixture's parts land on is the arranger's
decision and a fixture that missed the wave channel would compare silence with
silence.
