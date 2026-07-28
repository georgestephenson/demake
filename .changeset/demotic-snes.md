---
"@demake/core": minor
"@demake/demotic": minor
"demake": minor
---

`demake build -c snes` compiles a Demotic game into a real Super Nintendo
cartridge — a fourth console, and the first one that is bigger than the language
needs.

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
  run time, and a Mode 1 S-PPU with BG1 and the object layer. It is what the
  conformance suite boots and what the web app plays, so no core is fetched from
  a CDN and none is shipped as WASM we cannot read.
- **The art path** demakes a 256×224 backdrop into 4bpp tiles across seven
  sixteen-colour sub-palettes — the eighth of each half is the font's — and puts
  the tile bank in a _second cartridge bank_ that reaches video RAM by transfer,
  so sixteen kilobytes of art costs the 32 KiB program bank nothing.

Sound is the one gap and it is a chip model rather than a language feature: the
S-SMP is a second processor with its own program and there is no S-DSP model for
a driver to be faithful to. A game with `music` and `sound` builds, records what
each rule asked for — a field of the trace, so a silent build traces identically
to a sounding one — and makes no noise; the web app's button says "No sound yet".

Output bytes: no existing console's cartridge changes. `Packing` gains a `pairs`
member for the S-PPU's plane-pair tile layout, which no other family emits.
