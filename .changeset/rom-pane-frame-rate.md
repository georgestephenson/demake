---
"@demake/web": patch
---

Pace and report a cartridge at its own console's frame rate.

The ROM pane divided by a single frame rate, written when both machines that
could build a cartridge were Game Boys and 59.7 was the honest figure for both.
Twelve consoles later, eleven of them still tick 60 times a second and the
WonderSwan ticks 75.47 — so its cartridges ran a fifth slow in the page, and the
counter under the screen then reported the rate they had been slowed to: one
frame per tick, 60 Hz, on a machine drawing 75 frames a second.

It comes from `findProfile(console).fps` now — the rate a game's speeds were
already resolved against, so it is the right denominator for a cost measured in
frames per tick and there is no second table to keep. The browser suite asserts
the reported rate follows the console.

Also: the pane's screen-reader label named eight consoles and called the other
four "a console". The PC Engine, the Game Boy Advance, the Nintendo DS and the
WonderSwan Color are named.
