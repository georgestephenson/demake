---
"@demake/demotic": minor
"@demake/web": patch
---

Make the example games playable, and fix three backend bugs they exposed.

**Games.** Pong's ball is faster, its opponent slower, and the opponent now aims
at a point beside the ball rather than dead on it, so a rally comes back at an
angle and can be won. The platformer and the caves ground their jump on
`footing`, an invisible `number` set by the collision phase and read by the jump
after it — so a jump can no longer be renewed in mid air — and the jump itself
now clears the step between shelves. The dodger's rocks recycle to a column drawn
from the seeded generator near the ship instead of falling down six fixed lines,
score what they dodge, and can be won or lost. The shooter has a three-shot
magazine. The runner's flap and gravity are a flapper's rather than a jumper's,
its chunk vocabulary has a fourth piece with a slot through the middle, and its
corridor is four rows rather than seven. Every counter has a caption beside it.

**Backend.** Art is converted per _instance box_ rather than once per file at the
largest box, so a five-cell shelf is no longer painted eleven cells wide with
nothing under six of them. A scene that scrolls draws its HUD with sprites, so a
counter pinned to `camera.x` lands on the same pixel each frame instead of
sliding with the background and snapping back. And `visible 0` now stops
separation as well as collision, so collecting a coin no longer shoves the
player off it.

Output bytes change for every game, because the generated code got a good deal
cheaper — which is what paid for the games above. Object-versus-object collision
is a shared routine over a staged box rather than inlined per pair; the cells an
object overlaps are walked once and read by every tile rule and the separation
pass, rather than walked once per rule; the walk is clipped to the grid up front
rather than bounds-checked per cell; a static caption is painted with the
background instead of repainted every frame; and objects the view does not cover
are culled, in whole cells, before either the OAM build or a collision pair
touches them. Without the first the shooter's three shots against nine aliens
would not fit in a 32 KiB cartridge; without the rest the cavern's twelve
collectibles would not fit in a Game Boy's tick.
