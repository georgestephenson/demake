---
"@demake/demotic": minor
---

The Neo Geo Pocket Color expression compiler.

`codegen/ngpc/expr.ts` turns a Demotic expression into straight-line TLCS-900/H.
Every decision about what an expression _means_ is `shape.ts`'s, so no two
backends can disagree; what is here is only how it is spelled.

Three things this machine spells better than any predecessor. **A property read
through a pointer is three instructions and no scratch** — `ld XIX,(ptr)` then
`ld XWA,(XIX+16)` reads a whole 16.16 property out of a record — which is what
makes a looped rule body affordable. **The generator's modulo is one
instruction**, because `div` leaves its remainder in the high half of the
register it divided, where the Z80 needs a twenty-one-byte loop. And **the
generator advances with three multiplies and no loop**: the low half of a 32×32
product is `al·bl` plus the low half of `ah·bl + al·bh`, and the top product only
reaches bits the modulus discards.

`ngpc-arith.test.ts` grows an expression section that proves the draw against
`rng.ts` bit for bit — including the degenerate bounds that still advance the
state, because _when_ a draw happens is part of the language — plus every
builtin and every relational operator used as a value.
