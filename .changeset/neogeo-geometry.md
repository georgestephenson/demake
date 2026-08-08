---
"@demake/demotic": patch
---

Work out the Neo Geo's playfield geometry, which turns out to be unlike every
other console in the set.

**A hardware cell here is 16×16 and a language cell is 8×8.** Every other machine
draws its playfield from 8×8 tiles, so a level's grid maps onto the tilemap one
cell to one cell. This console's playfield is built from *sprite* tiles and the
smallest of those is sixteen pixels square, so one plane cell covers a **2×2
block of language cells** and the mapping is 2:1 on both axes.

Three things follow, and the third is what changes the estimate for the renderer.
The plane is 21×15 cells against a 20×14 screen, which is smaller in cells than
any other console's map while covering more screen — that is what makes
twenty-one sprite strips enough to be a tilemap at all. The HUD is untouched,
because the fix layer is 8×8 at 40×28, which *is* the language's own cell grid:
the only console here where a HUD cell and a language cell are the same object
with no arithmetic between them, and the second reason (after its priority) the
HUD belongs there. And **the level grid has to be composed at build time** — the
art path must take each 2×2 block of the grid, compose four 8×8 patterns into one
16×16 tile, and dedup those. That is legal only because a Demotic tile layer
cannot change, which is doc 13 §D6's still-to-come work.

The PC Engine hit the first half of this ("there is no 8×8 sprite", so an object
is composed from four patterns) and `pce-art.ts` is the precedent. What is new is
that the *background* has the same problem, which that console does not have
because its BAT cells are 8×8.
