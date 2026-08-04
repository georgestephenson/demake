---
"@demake/core": minor
"@demake/chip": minor
"@demake/audio": minor
"@demake/demotic": minor
"@demake/pce": minor
"demake": minor
---

Give the PC Engine its sound: a wavetable PSG, a binding, and a generated
HuC6280 driver inside the game.

`demake arrange -c pce`, `demake sfx -c pce` and `demake render -c pce` now
demake for the HuC6280's own PSG, and `demake build -c pce` puts a driver in the
cartridge — so the whole example library plays on that machine, proven tick for
tick against the schedules the demakers produced by
`packages/demotic/test/audio-pce.test.ts`. It is the twelfth console that demakes
music and the eleventh whose cartridges can play it.

`@demake/chip` gains `Huc6280Psg`, the eighth chip model and the only one whose
every voice is a wavetable: thirty-two five-bit samples of RAM per channel, a
twelve-bit divider, five-bit volume, and a shift register on two of the six
channels. Volume is three attenuators in series in 1.5 dB steps — the channel's
own, its left/right balance and the chip's global level — so a level is a table
lookup on a sum. The LFO and the direct D/A's use as a sample player are stored
and inert, and both are named as gaps rather than left to be discovered.

`binding/pce.ts` is the encoder, and two things about it are this chip's alone.
The **channel is a register and the chip latches it**, so the tag `data.ts` asks
for carries a select latch exactly as the SN76489's tag carries a data-byte latch,
the driver skips a preempted run whole, and `checkSelectDiscipline` refuses a
schedule in which some run does not open with a select. And **which timbre a voice
plays is decided at boot**: a driver uploads a waveform through the register port
rather than selecting one, so `binding/pce-bank.ts` gives the five pitched voices
five different shapes — a triangle, a saw, and three pulse widths — which is more
timbral variety than any other eight-bit console here can hold at once.

The driver shares its stream player with the NES. `rom/nes-driver.ts` is now
`rom/mos-player.ts` and belongs to the **processor** rather than to either
machine, on `arm-player.ts`'s precedent; what each console adds is `nes-game.ts`
and `pce-game.ts`. The NES's output bytes are unchanged. What the PC Engine adds
is its clock — the CPU's own timer at 120 Hz, where the NES has only the frame —
and the fact that **no register is written by both streams**, so the build emits
no merge routine: the third console in the set with none, after the Master System
and the Mega Drive.

Its channel palette puts the pulses first, as every other console's spec does,
because the sound demaker places a pitched gesture on the _first_ pitched channel
— the difference between an effect borrowing a lead voice and one silencing the
bass every time it fires. And its `writesPerTick` is larger than any other
eight-bit console's for a reason that is the waveform upload's alone: the tick
carrying the chip's initialisation is a hundred and sixty writes longer here, and
the budget has to cover it.

The page plays it, through the same `StreamSink` every other console uses.
