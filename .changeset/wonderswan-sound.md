---
"@demake/chip": minor
"@demake/audio": minor
"@demake/demotic": minor
"@demake/web": minor
---

Sound on the WonderSwan, from a driver with no interrupt to ride.

`demake arrange -c wsc` and `demake sfx -c wsc` demake a track and an effect for
this console, `demake build -c wsc` puts them in the cartridge, and the page
plays them. Both machines demake — the mono WonderSwan has the same sound
hardware, and a demaker is per-domain, so `arrange -c ws` works on a console
`build -c ws` cannot target — and the colour one plays, because that is the one
with a game backend.

`@demake/chip` gains `WsSound`: four wavetable channels of thirty-two four-bit
samples, which is the PC Engine's arrangement with two fewer voices. What is not
the PC Engine's is where the waveforms live. **They are the console's own RAM** —
port `$8F` carries bits 6–13 of an address and the chip reads sixty-four bytes
from there — so the model is handed the machine's memory the way its display
already is, the bank is _bytes a driver copies_ rather than register writes it
performs, and `WS_WAVE_BASE` is one constant with three readers: the binding
writes the register, the renderer places the page behind the model so a
standalone track sounds like a cartridge, and the memory plan reserves it.

Three more things are this chip's. The pitch register counts _up_: it is
subtracted from 2048 rather than dividing, so a larger value is a higher note,
and the spec declares the lattice while the binding does the subtraction. `$90`
is the shared register — all four channel enables and the bit that puts channel
four on its shift register in one byte — so the driver merges rather than
stores, and the fold has to reach a mode bit four places above the channel it
belongs to. And noise is a **tap** rather than a rate: eight positions on a
fifteen-bit register decide the sequence's length while the channel's own divider
decides its pitch, so a drum here has a colour _and_ a pitch where a Game Boy's
has only a period.

The cartridge carries a generated V30MZ driver — the sixth processor to get one
— and its clock is what makes it unlike the other seven. This cartridge takes no
interrupts anywhere: the main loop watches the beam, and the audio driver reads
the **vertical-blank timer's counter** and pays whatever frames it finds owed. A
frame the game overran is therefore owed rather than lost, which is the
frame-counting discipline every other frame-clocked console needs a handler to
achieve. `packages/demotic/test/audio-wsc.test.ts` runs the whole shared battery
on it, diffing every register write against the demakers' schedules tick for
tick.

VGM carries all of it, wave table included: `0xBC` writes a register and `0xC6`
writes the memory the chip reads, so a WonderSwan track is a whole artifact
where a Super Nintendo's is half of one.

Two sixty-hertz assumptions in the shared battery are fixed on the way past —
"a hundred and twenty frames is two seconds" is not true on a machine that draws
75.47 of them. No other console's output bytes change.
