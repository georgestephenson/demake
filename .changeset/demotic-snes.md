---
"@demake/core": minor
"@demake/chip": minor
"@demake/audio": minor
"@demake/demotic": minor
"demake": minor
---

`demake build -c snes` compiles a Demotic game into a real Super Nintendo
cartridge — a fourth console, the first one that is bigger than the language
needs, and the first whose sound is a **second computer**.

- **A 65816 assembler and a LoROM wrapper in `@demake/core`** (`asm/wdc65816.ts`,
  `asm/snes-cart.ts`), so the browser produces byte-identical cartridges with no
  toolchain, exactly as the SM83, 6502 and Z80 halves already do. An immediate's
  width is the caller's — `imm8` and `imm16` are different operands — because the
  opcode does not carry it and guessing wrong desynchronises the instruction
  stream rather than producing a wrong number.
- **A `snes` codegen backend** (`codegen/snes.ts`, `codegen/snes/`), which
  implements `Backend` and moves nothing out of it or out of `shape.ts`. The
  whole example library traces identically to the reference interpreter in the
  same battery every other console runs, at the same one frame per tick.
- **`@demake/snes`**, a self-hosted core: a 65816 whose registers change width at
  run time, a Mode 1 S-PPU with BG1 and the object layer, and an S-SMP — an
  SPC700 with its own 64 KiB, its own timers, and a boot ROM of ours that speaks
  the documented upload handshake. It is what the conformance suite boots and
  what the web app plays, so no core is fetched from a CDN and none is shipped as
  WASM we cannot read.
- **The art path** demakes a 256×224 backdrop into 4bpp tiles across seven
  sixteen-colour sub-palettes — the eighth of each half is the font's — and puts
  the tile bank in a _second cartridge bank_ that reaches video RAM by transfer,
  so sixteen kilobytes of art costs the 32 KiB program bank nothing.

**And it has sound**, which on this console means a whole second program.

- **An S-DSP model in `@demake/chip`**: eight voices, BRR decoding with all four
  predictors, ADSR and the five `GAIN` modes, the noise generator, and per-voice
  signed stereo volumes. Pitch here is a **multiplier** rather than a divider —
  the first chip in the set that counts up — so `PitchLattice` gains a `kind` and
  nothing ever has to be octave-folded to fit. The echo unit and pitch modulation
  are deliberately absent rather than half-implemented, and interpolation is
  linear where the hardware's is a four-tap Gaussian; both are stated in the
  model rather than guessed at.
- **An SPC700 assembler in `@demake/core`** and a **generated driver** in
  `@demake/audio` (`rom/spc-driver.ts`, `rom/spc-game.ts`) — the fourth CPU here
  and the first that is not the console's own. A cartridge uploads the driver,
  its tables, its schedules and a bank of single-cycle BRR waveforms through four
  mailbox bytes at boot, and after that the game posts two request bytes and
  carries on: the tempo is the sound processor's timer, not the picture's, so a
  frame the game overruns costs it nothing.
- **`packages/demotic/test/audio.test.ts` runs on this console too**, watching the
  _sound_ processor's program counter and diffing every S-DSP write against the
  schedules the demakers produced. `packages/audio/test/spc.test.ts` proves the
  same driver one layer down, so a failure names the driver rather than the game.
- **`demake arrange -c snes` writes an `.spc`**, because VGM has no block for a
  sample player and could not usefully have one — the format this console
  actually has is a snapshot of the sound processor's RAM, which is exactly what
  the cartridge uploads.

The web JS budget moves from 310 KB gzipped to 360, which is the largest single
step it has taken and the second time it has moved for a whole console. The
vertical is 48.7 KB: two assemblers and the largest codegen backend in the core
worker, a 65816 and an SPC700 in the game chunk because doc 07 forbids fetching a
core, and the S-DSP with its driver in the audio worker. Nothing is duplicated
across chunks and the emulator reaches neither worker; both were checked before
the number moved (`tools/ci/check-web-budget.mjs`).

Output bytes: no existing console's cartridge changes. `Packing` gains a `pairs`
member for the S-PPU's plane-pair tile layout, which no other family emits, and
the driver format gains a wide channel mask for chips with more than four voices,
which no other console asks for.
