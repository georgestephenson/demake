---
"@demake/core": patch
---

The game section opens on the cartridge, with a `View` dropdown.

The ROM used to sit _under_ the preview, which had the ordering backwards: the
cartridge is the artifact — what `demake build` writes, what a player would load
— and the interpreter is what proves it right. So the pane now opens on the
cartridge, in the place the preview held, and `View` offers _Cartridge_ (the
default), _Preview_, or _Side by side_. Side by side is the mode that earns its
place: two machines, one input path, and any disagreement visible at a glance.

Only the view on screen runs. A hidden preview is work nobody sees — the
cartridge is machine code and never consults the interpreter — so the simulator's
loop stops with it, and the input latch is cleared so a tap taken while it was
hidden cannot fire a minute later when it comes back.

Sound belongs to the cartridge, and that is a fact about the two machines rather
than a layout decision: the interpreter says _when_ a sound is asked for (the
trace's `audio` field) and knows nothing about chips, channels or registers,
because a `.dmt` names none of them. In _Preview_ there is no sound control at
all, which is the honest way to say a simulator has nothing to play.

Two things that fell out of putting the cartridge first: **Restart restarts what
you are looking at** — the section's button now resets both machines, and the ROM
pane's own Reset is gone rather than sitting a few centimetres away doing the
same thing to one of them — and **a dropdown gives the keyboard back** when you
change it. A focused `<select>` keeps the keys, so pressing Z to start playing
right after picking a game went to the dropdown's type-ahead instead of the
player's A button.
