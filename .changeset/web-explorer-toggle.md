---
"@demake/web": patch
---

The explorer gets a switch on the screen, and folds itself away on a phone.

**A button on the title bar**, at the left where every editor with a sidebar puts
one, showing a filled column while the tree is there and an empty one when it is
not. Hiding the file list was a View-menu entry and `Ctrl+B` and nothing else,
which is a control you have to already know about — and once the tree is gone the
menu is also the only way back to it, through two clicks and a submenu.

**And below 1000px it opens folded.** That is the width the workbench already
stacks the explorer above the editor at, so on a phone the first thing on screen
was a third of a screen's worth of file list sitting on top of the thing you came
to look at. The viewport decides how the page opens and nothing watches it
afterwards: a rotation or a resized window is not a reason to overrule the button
somebody just pressed.

The accelerator is still declared once — the menu entry and the button's tooltip
read the same string, and the tooltip renders it through the menu bar's own
platform-aware formatter, so a button cannot come to advertise a shortcut the menu
has since changed. The stacked layout also drops to a one-row grid when the tree
is off, because an editor left in a row sized to its content is one the window
clips with nothing to scroll.
