---
"@demake/core": minor
"@demake/demotic": minor
"demake": minor
---

`demake build -c md` compiles a Demotic game into a real Mega Drive cartridge.

68000 machine code written for the game, a 512 KiB image with its vector table,
header and word checksum, and the art it names demade by the image pipeline into
a 1408-tile bank across three of the VDP's four sub-palettes. The whole example
library traces identically to the reference interpreter there, in the same
battery the other five targets run, at the same one frame per tick — and the web
app plays it in the page, byte-identical to the CLI's cartridge.

The fourth backend, and the first 16-bit one. Nothing moved out of
`codegen/backend.ts` or `codegen/shape.ts` to make room for it: the only thing
this console owns is an instruction set. What the wider machine changes is the
_value layer_ — a 16.16 number is a register here, so `move.l`/`add.l`/`cmp.l`
each do in one instruction what the Z80 does in four, and the only two routines
pulled in are a 32×32 multiply built from four `mulu.w` products and a divide
whose fast path is two `divu.w` instructions. Neither is a bit loop, which is
what makes an object whose _speed_ changes affordable here.

New in `@demake/core`: `Asm68k`, the fourth encoder, written in TypeScript for
the reason the other three are — the browser has no assembler, so the page
produces the same bytes the CLI does; `packMdRom`, the cartridge wrapper; and a
`packed4` tile packing for `buildSpriteBank`, because this VDP reads a tile as
colour indices rather than as bitplanes.

Three shared pieces grew to make room, none of which changes any other console's
output bytes: the RAM allocator aligns anything wider than a byte where a
`MemoryPlan` asks for it (an odd word access is an address error on a 68000), the
ROM trace reader reads a machine's own byte order (this is the first big-endian
console), and `MemoryPlan` carries both facts.

Sound is in a changeset of its own (`md-audio`): the PSG half of this console's
sound hardware is driven, the FM half is not.
