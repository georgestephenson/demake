---
---

Adds four example games beyond Pong — Breakout, a platformer, Dodger and a
shooter — each chosen for something the others do not exercise, with a
`.test.dmt` suite apiece. All five compile for all seven consoles, stay inside
every sprite budget, and pass their suites on every one: 196 cases.

Writing them changed the language three times. `touches` is a level-triggered
collision, because resting contact is not an event. `reaches` became a crossing
detector, because a `>=` threshold fires immediately on a counter that falls.
`visible 0` now means inert — not drawn, not collided with, not moved — which is
how an object leaves play and why there is no `destroy`.

No release: `@demake/demotic` is unpublished and no published package's bytes
change.
