---
"@demake/web": patch
---

The window keeps its name on a phone, and the window stops being wider than the
phone.

**A narrow window moves the title rather than dropping it.** The name is centred
because that is where a desktop puts a window's title — and it is also where the
menus are once the window is small, which is why the strip used to drop the
tagline below 900px and the name itself below 640. Below 900px it flows to the
right of the menus instead, and on a phone the strip wraps and the title takes
the row above them, whole. The tagline gives up characters to an ellipsis before
it gives up its row.

**And the window is the window.** The workspace grid stated its rows and left its
one column implicit, which sizes to its widest item's max-content — so a toolbar
or a line of source wider than a phone made the whole window that wide, title bar
and status bar included, and `overflow: hidden` then cut the surplus off with
nothing able to scroll to it. At 375px the game section's toolbar lost its last
button and the status bar lost its right-hand end. `minmax(0, 1fr)` pins every
row to the window and hands the overflow back to the regions that know how to
scroll it, which is also what lets the tagline's ellipsis mean anything.
