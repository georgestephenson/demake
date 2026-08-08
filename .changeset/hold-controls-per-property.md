---
"@demake/demotic": minor
---

Fix two ways an `on hold` control could leave an object moving with nothing held.

Both had one cause: the snapshot `on hold` puts back on release was kept per
_binding_ and taken on the button's _press edge_.

**Two directions at once.** `left` and `right` on one paddle both write
`xdirection`, so the second button to go down saved whatever the first had
already written. Releasing them in the order they were pressed then wrote that
back after both were up, and the paddle slid away untouched — `right` still
"on" after `right` was let go. Releasing one of the two also cost a tick of
standing still, because the restore ran after the button still down had applied.
The snapshot now belongs to the **property**: it is taken when the first of its
buttons goes down and put back when the last comes up, so both orders end at
rest and the survivor takes over within the tick. Which of two bindings wins
while both are down is unchanged — the one declared later, as before.

**A direction held into a new scene.** A control does not run in scenes its
object is not in, so a game entered by pressing `a` with `right` already down
never saw that press: nothing was saved, and the release had nothing to put
back. The hero kept walking for the rest of the game. A hold now engages on the
button being _down_ rather than on its edge, so the scene's own first tick saves
the value it is about to overwrite.

`sim.ts` is the specification and all eight backend families implement it, so
every console is fixed alike; the shared battery gained a tape that presses both
directions and starts a scene holding one, on all thirteen machines.

Cartridge bytes move on every console. The hold state is now one four-byte slot
and one flag per property rather than per binding, so a game binding two buttons
to one property gets five bytes of RAM back and every address after it moves,
and the emitted control block is one shape for all three modes instead of three.
No golden trace changes: the recorded tapes never held two opposing buttons or
crossed a scene with one down, which is exactly why neither bug was caught.
