---
"@demake/web": patch
---

Draw the Mega Drive's picture in the page. This VDP renders when it is asked
to rather than as the beam passes, so the ROM pane's frame loop has to end a
frame with a `view()` the way the Game Gear's crop does — without it a
cartridge played perfectly behind a canvas still holding the blank frame boot
rendered.
