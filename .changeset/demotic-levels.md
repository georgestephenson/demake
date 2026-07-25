---
---

Gives Demotic a background layer, a camera and a random source.

`level <name> from <file.dmtl>` loads a hand-drawn playfield. A scene's bounds
become its level's, so `screenright` means the end of the level rather than an
invisible wall a screen-width in, object positions are level coordinates, and
`camera follows <object>` decides what is on screen — which is why scrolling does
not infect every rule in the game. A game with no level is unchanged.

Tiles are named by the `.dmtl` legend and collide on the same two conditions
objects do: a rule has to name the pair, and separation happens only where the
tile is `solid`. So `when player touches spikes` reads as a sentence, a coin
scores without blocking, and a wall blocks whether or not anything fired.

`stream <name> from <chunk>, <chunk>, … <n> wide|tall` composes a course by
drawing chunks from the program's `seed`. It runs at compile time and emits an
ordinary tilemap, so the simulator, the camera and a future console runtime need
no notion of streaming and a trace stays a trace. `seed <n>` and `random(low,
high)` make the generator part of the language rather than the host's — the seed
lives in the game, never in the Demakefile.

Two examples came with them: `caves` (a 60×30 hand-drawn level, tiles, a
scrolling camera, a HUD pinned to `camera.x`) and `runner` (24 chunks composed
from three files, and `random` at run time). Both pass their `.test.dmt` suites
on all seven consoles, and both play in the web preview.

One bug fix in the `.dmtl` parser, which changes level bytes: a blank line inside
a grid is a row of empty cells, not a separator. Dropping it moved every row
below it up one.

No release: `@demake/demotic` is unpublished and no published package's bytes
change.
