---
"@demake/demotic": minor
---

Loop the NES's collision rules over their objects instead of copying the code
once per object. Three shots against nine aliens is twenty-seven pairs, and each
pair was the same program — a near test, box staging, the overlap, the rule body,
the separation, the contact bit — with a different address baked into it, at
about 350 bytes a copy. Nine aliens against two screen edges was the same again
on the subject side.

The other object's record now goes in a page-zero pointer and the body is emitted
once, with a four-byte table entry per pair carrying the address and the contact
bit. `EntityAddr` has had a `ptr` case since the backend interface was written
and the expression layer implements it, so a rule body needed no special
handling: `alien.visible as 0` became an indirect store instead of an absolute
one. `emitEdgeTest` and `emitEdgeSeparate` now read and write through an
`EntityAddr` for the same reason.

A loop is taken only where the objects agree about what the unrolled form baked
in — the near-test margins, whether `visible` can change, and (on the subject
side) their size — and below three objects the unrolled form is still smaller.

The shooter's collision code goes from 12,217 bytes to 2,472, which takes the
cartridge from not fitting at all to 10,291 bytes free. Every fixture's trace is
unchanged, which is what `rom.test.ts` checks tick by tick on all three consoles.

NES cartridge bytes change.
