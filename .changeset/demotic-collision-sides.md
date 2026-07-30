---
"@demake/demotic": minor
---

A collision can say which side it happened on.

```
when hero touches ledge, ground from above then (ydirection, footing.value) as (0, 1)
when hero hits wall from below then ydirection as 0
when hero hits crawler from above then (crawler.visible, ydirection) as (0, -1.2) else hurt.value as 1
```

`from above, below, left, right` narrows a `hits` or `touches` rule to contacts
resolved on those sides, and each name describes **the subject's** position —
`hero touches ledge from above` is the hero above the ledge, which is a landing.
That is the reading the sentence has out loud, and it is the one the platformer
case needs. Without a `from` a rule fires on any side, so every program written
before this means exactly what it meant. A screen edge takes no `from`, because
it has only one side. (Surface agreed with the maintainer before implementing,
per AGENTS.md §Language changes.)

**The side and the separation are one decision.** Pushing an overlap apart means
choosing the shallower axis and a direction, and that choice _is_ the side —
`level/scene.ts`'s `contactOf` now returns both, and the rule gate and the push
are the same arithmetic read twice. They cannot disagree, which is the property
worth having: a rule that takes footing `from above` can never fire on a contact
the runtime then resolved sideways.

This closes the gap the `quest` fixture was designed around. A contact used not
to say which side it happened on, so footing taken from a landing surface was
taken from its sides too: a solid slab of ground was a slab you could inch up,
and a pit was something to hang on the lip of. The workaround was geometric —
every landing surface one cell thick over `bedrock`, every pit six cells wide —
and it can now be a rule instead.

**No backend emits the side test yet, and the build says so.** `unsupportedFor`
names `` `from <side>` on a collision trigger `` for every console, so a program
using it compiles, previews and traces but refuses to build a cartridge — rather
than building one that ignores the clause and plays a different game from the
preview (AGENTS.md §Iron rules). Closing it is one routine per backend: the pair
separation already computes the axis and the sign, so it wants splitting into a
part that decides the side and a part that applies the push, exactly as the
interpreter's did here.
