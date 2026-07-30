---
"@demake/demotic": minor
---

Quest joins the example library: three levels, a boss, and a room behind a pipe.

The biggest example by some way, and it is here for what the small ones cannot
show. Stomping an enemy rather than dying to it, coins that buy a life at a
hundred, bricks that break only with a power-up in hand, thorns and lava and pits
that do not, two power-ups that change what the hero can do, a secret room the
level's own geometry hides, a collectable that is not currency, and a fight at
the end of it — four `.dmtl` tilemaps, four demade tracks and eight demade
effects.

Two things it establishes that the other examples do not:

**A rule can name a class and cover every level at once.** Almost every rule in
`quest.dmt` names `hero` rather than one of the four hero objects, because a
class rule binds each instance in turn and skips the ones whose scene is not
running. One line of gravity is gravity in all four levels. What cannot do that
is a rule a button fires, because a button has no collision to bind from — so the
jump and the fireball are written per scene, and the split is visible in the
file.

**State that outlives a level lives in `title`.** Entering a scene resets that
scene's objects, so coins, lives and the power-up are declared in the scene the
game starts on and read from everywhere. Reaching `title` is a new game, and that
is the same fact stated once rather than a reset routine.

Two things the fixture found and the file now says out loud. A landing rule wants
`ydirection > 0` and not `>= 0`: a cell-wide hero under a ledge touches two of
its cells in one tick, the first sets `ydirection` to zero, and `>= 0` reads that
back as a landing on the second — so bonking your head handed you a jump. And a
rule that stops a rise must name only the tiles that are overhead, because a
contact does not say which side it happened on, so an `else` on the landing rule
cancels a jump every time you brush the edge of the platform you were aiming for.

Its levels are shaped by the same fact: a landing surface is one cell thick with
`bedrock` underneath, and the pits are six cells wide, because a hero two cells
tall catches the far lip of anything narrower instead of falling clear — and a
pit you can hang on is not a pit.

`quest.test.dmt` runs on all eight consoles, and the game traces identically on
all eight. Its cartridge builds on the Mega Drive; on every other console it is
over the mapper-less limit, which `docs/13-roadmap.md` now records with the
measured numbers.
