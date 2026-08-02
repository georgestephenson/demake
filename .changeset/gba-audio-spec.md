---
"@demake/core": minor
"@demake/audio": minor
"demake": minor
---

Describe the Game Boy Advance's sound hardware, and stop the support matrix
guessing from a spec.

`gbaAudio` is the first `AudioSpec` in the set with two chips of _different
kinds_: four Game Boy channels — the same `gb-apu` under a permuted register
map — and beside them two eight-bit converters fed by DMA at a timer's rate.
What those two carry is a software mix, so the six voices declared for them are
the demaker's rather than the hardware's, in exactly the sense the Super
Nintendo's eight are: the machine offers sample playback and how many voices fit
in it is a CPU question, which `@demake/chip`'s `GbaPcm` answers at six. Ten
voices, which ties the Mega Drive for the largest palette here and is split
differently.

Their pitch lattice counts _up_, like the S-DSP's and unlike every divider in
the set: a voice plays at `32768 × step / 65536` samples a second with a
twenty-four-bit step, so the steps are uniform in frequency and 0.03 Hz apart.

Adding a spec exposed a lie in the derived support matrix, which read
"does this console demake music" and "does a cartridge play it" off
`spec.audio` — so the moment the hardware was described, both columns claimed
yes. Neither is a fact about the hardware. They are now derived from the two
registries that actually decide: `audioConsoles()` for what `arrange`, `sfx` and
`render` can encode, and a new `gameAudioConsoles()` for the consoles whose CPU
has a driver written for it. The Game Boy Advance is in neither yet, and the
matrix says so.

`gameAudioConsoles()` and `hasGameAudio()` are keyed by console rather than by
chip, for the reason the spec makes plain: a driver is a _CPU's_, and the same
`gb-apu` is driven by an SM83 on one machine and would need an ARM7 on this one.
The standalone-cartridge table is keyed the same way now, so nothing can resolve
a Game Boy Advance schedule to a Game Boy cartridge.
