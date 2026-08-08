---
"@demake/demotic": minor
"demake": minor
---

`from above` builds a cartridge, on every console.

The clause has been in the language and in the reference interpreter since
collisions were, and it was the one entry `unsupportedFor` ever carried: a
program that said `when hero touches ledge from above` previewed, traced, ran in
`.test.dmt` — and then refused to become a ROM, because no backend emitted the
side test. All eight of them do now, which is one change rather than eight
because the gap was in the emitters as a group rather than a difference between
them.

**The answer was already being computed.** Separating an overlap means choosing
an axis and a direction, and _that choice is the side_ (`level/scene.ts`
§contactOf) — so each backend's separation was split into a part that **decides**
and a part that **applies**, and the new routine is the decision read out as a
bit instead of a push. A rule and the push that follows it therefore cannot
disagree, which is the property the clause exists to make usable: footing is
taken from a landing and not from the edge of the platform you were aiming for.

Three things about the shape are worth knowing.

**The bit numbering is the language registry's**, not each backend's:
`shape.ts` derives one bit per side from `SIDES`, so a `from` clause compiles to
one `and` and one branch on every machine and no emitter picks its own encoding.

**The gate skips the whole contact**, not only the firing. A side the rule did
not name is a contact that never happened, so it separates nothing and records
no contact bit either — which is exactly what the interpreter's `continue` does,
and a cartridge that separated anyway would drift a tick later with nothing about
the arithmetic wrong.

**It is pulled.** A game with no `from` in it emits not one instruction, so every
cartridge this repository built before this change is byte-identical after it —
checked directly, seven games across fourteen consoles.

Both halves of the contact model are covered: an object pair, and a cell of a
level. The tile half narrows the _firing_ only, because what can hold an object
up is not what a rule asked about — a solid tile still stops it whichever side
the rule named.

**`platformer` uses it**, which is what the clause was designed for. Landing and
bonking were one rule and a velocity test (`if player.ydirection >= 0 … else …`);
they are now two rules naming two sides, and brushing a ledge's _flank_ no longer
grants footing at all.

`packages/demotic/test/collision-sides.test.ts` is the proof, on the terms every
other backend claim here is made on: one program, every console, diffed against
the reference interpreter tick for tick — four sides against an object and four
against a tile, each with a rule for the side it is on and a rule for a side it
is not.
