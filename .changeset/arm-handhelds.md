---
"@demake/core": minor
---

Add an ARM assembler and the Game Boy Advance / Nintendo DS cartridge wrappers —
the spine the two ARM handhelds' Demotic backends stand on.

`AsmArm` is ARMv4T in ARM state: data processing with every operand shape, the
long multiplies a 16.16 product is made of, both transfer encodings, block
transfers, branches, the status-register and coprocessor forms. It is the first
encoder here that buys three processors — a Game Boy Advance, and both of a DS's
— and the first whose _constants_ need a mechanism: a 32-bit value does not fit
in a 32-bit instruction, so `ldrConst` emits one PC-relative load and `ltorg`
places the word within the ±4 KiB the field reaches. Identical values share a
word; a load that cannot reach its pool is an error naming the flush rather than
a silent truncation.

`packGbaRom` wraps assembled code that already reserves its own header — a GBA
header _interleaves_ with the program, because the first word is the entry branch
— and computes the complement byte the BIOS checks. `packNdsRom` moves out of the
CLI: a `.nds` holds two programs, and its header is the only statement of which
bytes belong to which processor, so the display-ROM edge and the Demotic backend
must not each carry a copy of it.

No output bytes change: nothing yet builds through either path.
