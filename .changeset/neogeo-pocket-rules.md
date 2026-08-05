---
"@demake/demotic": minor
---

The Neo Geo Pocket Color's rule bodies: the tick, compiled.

`codegen/ngpc/rules.ts` is the conformance implementation of `sim.ts` for this
machine. The _order_ of the steps is not in it — `emitTickSteps` runs them — and
every decision about which rule can fire where is `shape.ts`'s; what is here is
the instructions, and four of them are shaped differently from the Mega Drive's.

**A predicate answers in the carry flag.** `scf` and `rcf` are a byte each and
`ret` does not disturb them, so a routine that decides something returns with the
carry set for yes and the caller's branch is the next instruction. The 68000
backend returns a value in `d0` and leans on `moveq` setting the codes; this is
the same trick with one fewer moving part.

**Copying a box is one instruction.** `ldir` walks a run from `(XHL)` to `(XDE)`
with `BC` counting, so staging a collision box is a block move rather than four
loads and four stores — and the same instruction commits the two properties back
afterwards, which is why this backend needs no `CommitPair` helper at all.

**A byte test is a compare against memory**, because a load sets no flags here;
and `bit` puts the _inverse_ of a bit into `Z`, which is why every button test
branches on `z` to skip rather than on `ne` to take.

**The cell an object sits in is at offset two**, not zero. This machine is
little-endian where the Mega Drive is not, and the cheap near test that culls a
collision pair reads that word directly — a backend that copied the other one's
`CELL_OFFSET = 0` would compare fractions and cull everything.
