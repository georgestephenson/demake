---
"@demake/core": minor
"@demake/chip": minor
"@demake/audio": minor
"@demake/vb": minor
"demake": minor
---

Add the Virtual Boy end to end: a V810 assembler, a self-hosted core, the `vb`
codegen family, a display ROM, and a pixel-perfect E2E against beetle-vb — and
with it the first **depth axis** in the project.

- **`@demake/core`'s eleventh encoder** is a NEC V810 (`asm/v810.ts`), the first
  RISC in the set: thirty-two 32-bit registers, a hardware multiply and divide,
  and a 32-bit constant built with `movhi`/`movea` rather than fetched from a
  pool. `asm/vb.ts` is the machine description three things read, and
  `asm/vb-cart.ts` puts the header and the vector table at the top of the image
  because a 27-bit address bus puts the reset fetch inside the cartridge's own
  last sixteen bytes.
- **The `vb` codegen family** emits characters, BGMap entries, the five palette
  bytes and a _world_ — the only structure any family here emits that carries a
  depth.
- **`@demake/vb`** is the eleventh owned core and the only one that renders two
  pictures, one an eye, offset by the parallax the scene declares.
- **`demake gen -c vb --format rom`** builds a bootable `.vb`, and it is the one
  display ROM with no external assembler behind it — no distribution ships a
  V810 one, so demake emits the program itself.
- **`demake arrange -c vb`, `sfx` and `render`** demake this console's music and
  effects. `@demake/chip` models the **VSU**: six voices, five of them wavetables
  of thirty-two six-bit samples, with a shared pool of five waveform tables, a
  hardware envelope on every channel, and **nothing shared between channels** —
  so this is the sixth console in the matrix that emits no merge routine at all.
  The VGM writer gains the `0xC7` command, whose sixteen-bit address is why this
  chip's registers are numbered by byte offset.

**Output-byte change**: the `vb` console spec's DAC ramp is now the LED ramp
beetle-vb actually renders at the brightness a demade cartridge programs
(`254, 185, 135, 0` rather than an evenly spaced `255, 170, 85, 0`). The spacing
is uneven because the emulator applies a gamma to the LED intensities; an evenly
spaced ramp fails the pixel-perfect comparison on every mid-tone. `prep -c vb`
output changes accordingly, on the Mega Drive's precedent that a DAC model is a
tested artifact rather than an idealisation.
