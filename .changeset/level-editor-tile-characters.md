---
"@demake/web": patch
---

The level editor lets you pick a tile's character.

The character a tile is drawn with was the one thing about a legend row you could
not edit: the name, the `solid` flag and the art were all fields, and the
character was a swatch you could only select with. So it was chosen once, by the
editor, when the row was added — and getting it wrong meant editing the file by
hand, which is the thing the map view exists to save you from.

It is a field now, in the place the swatch was, and it is still what selects the
tile to paint with — one box, both jobs, because two controls for one character
would be two things to keep in step. Adding a row keeps suggesting an unused
character, as a placeholder beside the button, and you can overtype it.

**Changing it redraws every cell that used it.** The character in a `tile` line
and the characters in the map are one name for one tile, so a rename that stopped
at the legend would orphan a room full of cells and leave the new entry drawing
nothing. That is the opposite of removing an entry, and deliberately so: a
removed tile is gone and its cells are left for the compiler to report, while a
renamed one is the same tile spelled differently. Only the rows holding that
character change; every other line of the file comes back byte-identical, which
is the rule the whole editor runs under.

**And a character another entry already draws is refused, out loud.** It is the
only refusal in the legend: a duplicate name is written and left to
`E_DUPLICATE_TILE`, because typing it back undoes it, while cells merged under one
character are what no later edit could pick apart.
