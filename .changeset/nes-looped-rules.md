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

The integrator goes the same way: objects are grouped by every compile-time
question `emitAxis` asks — whether speed and each direction can change, and their
values where they cannot — so a shared body is a proof rather than a hope, since
two objects in one group would have compiled to the same instructions anyway. A
property the emitter both reads and writes goes through `openProp`, which is the
property's own address for a named instance and a staged temporary for a looped
one, so the unrolled form is byte-for-byte what it was.

In the shooter: collisions 12,217 bytes to 2,472, movement 4,116 to 1,012. The
cartridge goes from not fitting at all to 13,371 bytes free. Every fixture's trace
is unchanged, which is what `rom.test.ts` checks tick by tick on all three
consoles.

NES cartridge bytes change.
