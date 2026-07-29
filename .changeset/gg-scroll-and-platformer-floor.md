---
"@demake/demotic": minor
---

Paint the column a Game Gear is about to show, and stop drawing a floor the
hardware cannot draw.

Two things a trace cannot see, one in the Sega backend and one in the example
library.

- **The Game Gear's edge painter was written for a Master System's name table.**
  Thirty-two columns against thirty-two leaves a Master System no spare column,
  so its incoming column goes into the cell straddling the masked left edge and a
  step back paints offset one. A Game Gear shows twenty of the same thirty-two
  and has twelve columns to spare, where both of those are the bug: the scene
  redraw painted the window and not the column past it, so the sliver a sub-cell
  scroll shows was whatever the last scene left there, and a leftward step painted
  the column _after_ the one that had just come into view. The invariant is now
  stated once — the name table holds the window plus one cell on each axis — and
  only the step back asks which machine it is. The same redraw fixed a Master
  System bug of the same shape one cell over: its shared cell held the near column
  until something scrolled, so the first rightward step showed the wrong tiles in
  the right-hand sliver.

- **The platformer's floor was eleven hardware sprites on one scanline.** Every
  one of these machines draws eight, so its right-hand third was simply missing,
  and the hero stepping into that row pushed one more off. A `25vw` ledge is worse
  the wider the screen — eighteen sprites on a Master System — so ledges are
  `5 cells` now, and the ground is `screenbottom` and the picture behind it rather
  than a platform spanning the screen. The shelves and their coins move down a row
  with it, so every step in the course is the four cells it always was.

Game Gear and Master System cartridge bytes change for every game with a level;
platformer bytes and traces change on every console.
