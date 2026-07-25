---
---

Demotic gains relative units (`vw`, `vh`, `vmin`, `vmax`) alongside absolute
cells, so a game can be balanced across playfields of different size rather than
merely sized. Adds the `abs()` builtin, quantises collision boxes to whole cells,
and rewrites the Pong fixture to be the same _game_ on every console.

Golden traces are re-baselined (`packages/demotic/fixtures/pong.gb.trace`): this
is an output-byte change to the language's semantics. No release — the package is
unpublished and no published package's bytes change.
