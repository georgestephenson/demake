---
"@demake/chip": minor
"@demake/core": minor
"@demake/audio": minor
"@demake/demotic": minor
"@demake/nds": minor
"@demake/web": minor
---

Give the Nintendo DS its sound: a chip model, a binding, an ARM7 driver, and a
second processor in the core to prove it on.

`demake build -c nds` now puts music and effects in the cartridge, and the whole
example library plays them tick for tick against the schedules the demakers
produced (`packages/demotic/test/audio-nds.test.ts`). `demake arrange -c nds`,
`sfx` and `render` demake all sixteen channels; the page's sound button works on
this console too.

**The chip is the widest palette in the set by a factor of three.** `nds-spu` is
sixteen channels that are sample players first, of which six switch to a duty
generator and two to a noise shift register — an S-DSP and a Game Boy APU on one
die, with a seven-bit panning _level_ per channel. Its source register is an
absolute address, so the model is handed the memory it reads from and the address
that memory begins at. IMA-ADPCM, the capture units and the hardware's own
32.7 kHz output stage are absent and named rather than half-implemented.

**The driver is the cartridge's other binary.** This console's sound channels
answer the ARM7 alone, so a build emits two programs — and unlike the Super
Nintendo's, the second one is not uploaded: a `.nds` names two binaries and the
loader copies both into the four megabytes they share, so the driver is running
before the game's first frame and asking for a track is one store to ordinary main
RAM. Three of its answers are this machine's. The clock is a **hardware tally** —
timer 0 reloads at the driver rate and timer 1 counts its overflows, so how many
ticks have happened is a register the driver reads rather than a flag it must
catch, and no interrupt is involved in this cartridge's sound at all. **Nothing on
the chip is shared**, so no merge routine is emitted anywhere. And sixteen
channels against a four-bit run field do not have to fit, on the Mega Drive's
terms: only the channels an effect was placed on are numbered, so fourteen voices
of a track play straight through a sound effect.

**The ARM stream player moved.** Two consoles now run this architecture, so the
walk over packed data is `rom/arm-player.ts` and belongs to the processor rather
than to either machine — the third thing in that directory that is nobody's
console. The Game Boy Advance's cartridges are byte-identical across the move.

Output bytes change for `nds` only: a cartridge for that console now carries an
ARM7 program where it carried a four-byte stub, and its request bytes are four
bytes of the game's own heap. Every other console is unchanged.
