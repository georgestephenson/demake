---
"@demake/core": minor
---

Add a TLCS-900/H assembler — the spine the Neo Geo Pocket pair's Demotic backend
will stand on, and the tenth encoder in `core`.

`Asm900` targets the TMP95C061 the Neo Geo Pocket and the Neo Geo Pocket Color
carry: a TLCS-900/H core in maximum mode, so the register file is the 32-bit one
and the address space is 24 bits. It is the first encoder here in which **the
operand comes before the opcode**. Every other CPU in this project puts the
operation first; this one spends its first byte saying where the operand is and
the byte after it saying what to do with it, so a `LD XWA,(XHL+4)` spells the
address arithmetic before the verb. `Mem` is therefore a value the caller builds,
on the V30MZ's mod/reg/rm precedent, and one method covers every form the operand
can take.

Two facts about that prefix reach anything built on this file. **A source prefix
carries the operand size and a destination prefix does not** — bits 5–4 are
"byte source, word source, long source, destination" — so `ld (mem),R` is a
destination form while `add (mem),R` is a _source_ one, because only the first
has a size in its opcode. And **the shortest encoding of an address is a property
of the address**: an operand below `$100` takes one byte, one below `$10000` two,
and a label three, so the CPU's own internal I/O page costs what it should and a
forward reference is never short.

Two more are the instruction set's rather than the encoding's, and both are why
this console is worth reaching. A **real multiplier and divider**: `mul` widens
its operands and `div` leaves the quotient in a register's lower half and the
remainder in its upper, so one instruction answers both questions a fixed-point
divide asks. And a **block copy in one instruction**, `ldir`, where every 8-bit
processor in this project pays for an upload loop.

The oracle is hand-read encodings against the published code maps, as most
encoders here get, with three of the cases taken from the manual's own worked
examples — `jr $2078`, `sla 4,hl` and `bit 5,($100)` — because an example carries
its object code where a table has to be interpreted. No distro ships a TLCS-900
assembler, so there is no differential oracle to be had.

No output bytes change: nothing yet builds through this path.
