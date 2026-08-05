---
"@demake/ngp": minor
---

`@demake/ngp` — the tenth owned core, starting with its processor.

A TLCS-900/H interpreter, written against the published instruction set rather
than transcribed from another core, for the reason `@demake/pce`'s CPU is
written twice: two independent readings disagree loudly where a copy inherits a
wrong answer in silence. Its tests are driven by `core`'s own encoder, which is
itself pinned against the published code maps — so the two files are a three-way
agreement rather than a circle.

Two things about this processor shape the model. **The operand comes before the
opcode**, so the decoder is two stages rather than one switch: it resolves an
operand and then dispatches on one of three tables, which is the shape of the
hardware's own code maps. And **the registers are a byte-addressable file** —
`XWA` is four bytes at register-file address `$E0`, `A` is the byte at `$E0` and
`W` the byte at `$E1` — so modelling the file as memory makes the register-index
addressing mode and the banked windows fall out instead of needing cases.

Two more are what will make this console affordable to compile for. A **widening
multiply and divide** are one instruction each, with the quotient in a register's
lower half and the remainder in its upper, where every 8-bit backend in this
project pays for a bit loop. And a **block copy is one instruction** — performed
one element per step here, because it is interruptible on the hardware and a
cycle count that hid that would be a lie.

What is absent is absent rather than half-implemented: no `link`/`unlk`, no
control-register access, no `swi`, and no register-bank switching beyond the
pointer itself. An opcode this does not decode raises by number rather than being
skipped. The display controller, the machine around them and the sound are still
to come.
