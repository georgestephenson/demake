---
"@demake/demotic": minor
---

The Neo Geo Pocket Color value layer, and the spine under its backend.

`codegen/ngpc/val.ts` is the smallest value layer in the project, and the reason
is the whole reason this console is worth a backend: **a 16.16 value is a
register here**, as it is on the Mega Drive. `ld`, `add`, `sub`, `neg`, `sra` and
`cp` each do in one instruction what the Z80 does in four and the 6502 in eight,
and `cp` leaves a _signed_ condition the processor can branch on directly rather
than one that has to be synthesised.

It is smaller than the Mega Drive's for two further reasons, and both are the
instruction set's. **The ALU reaches memory on the destination side**, so
`add (dst),XWA` is a 32-bit accumulate in one instruction with no pointer and no
scratch, where the 68000 needs a load, an add and a store. And **a long
conditional branch needs no inversion**: this is the only processor in the set
with both a ±32 KiB conditional relative branch and a conditional _absolute_
jump, so `ctx.far` and `ctx.farJump` are one instruction each where the 6502, the
Z80 and the V30MZ all invert a condition over an unconditional jump.

Two routines are the only ones this console pulls in, and both are shorter than
their Mega Drive counterparts because **the clamp does the work**. The
**multiply** is three 16×16 products and no carry propagation at all: both
operands are inside ±2^26, so their high halves are below 2^10 and the middle
product cannot overflow thirty-two bits — the 68000 version assembles a full
64-bit product because it does not lean on that. The **divide** is a
forty-eight-iteration restoring loop, because this console's own `div` is the
wrong shape: thirty-two by _sixteen_ with a sixteen-bit quotient, where a
`speed / fps` routinely wants more. Both floor toward negative infinity by coming
down one step when the result had a fraction, which is what `fixed.ts` does and
what a truncating negate would get wrong on every value with a fractional part.

`ngpc-arith.test.ts` proves all of it against `fixed.ts` on the hardware, through
`@demake/ngp` — so the encoder, the CPU model and the value layer are a
three-way agreement rather than a circle.

No console gains support: there is no profile and no registry entry yet, because
a profile without a backend is what `registry.test.ts` refuses and this backend
cannot assemble a cartridge until its renderer exists.
