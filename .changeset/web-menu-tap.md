---
"@demake/web": patch
---

Switching menus on a touchscreen takes one tap again.

A finger has no hover, so the `pointerenter` a tap fires is the first half of
that tap rather than a movement of its own — and the menu bar acted on it. With
File open, tapping Edit switched to Edit on the enter and then toggled it shut
on the click, so both menus closed and the second menu needed a second tap. The
hover-switch is now a mouse interaction, and a click on the title the pointer
just switched to keeps that menu open instead of closing what the same gesture
opened, which was the same bug with a mouse and a visible intermediate state.
