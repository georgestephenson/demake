---
---

Adds the `.dmtl` level format: a named legend, then the level drawn as a grid of
characters, one row per line. The shape in the file is the shape on screen, which
is what makes it readable and editable in place — an array of tile indices is the
opposite. Tile names are what Demotic rules will collide with.

Parser, diagnostics and a scrolling fixture only; the language statements that
load a level are still to come.
