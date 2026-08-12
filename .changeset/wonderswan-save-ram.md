---
"@demake/demotic": minor
"@demake/audio": minor
"@demake/core": minor
"@demake/wsc": minor
---

Bring the mono WonderSwan the RAM it needs, so `quest` builds on every console

The last of the sixteen consoles that build games, and the only one whose wall
was never the cartridge: sixteen kilobytes of work RAM, of which the tile bank is
the top half and the display's own structures are most of the rest, leaving 2 KiB
of heap for a game that wants six. No size of cartridge fixes that, and both
cheaper answers were measured rather than assumed — running the heap down to the
object shadow buys 192 bytes and taking the unused tail of the tile bank buys
128, because `quest` uses 504 of that machine's 512 tiles.

So the answer is the hardware's own: this console maps a cartridge's **save RAM**
at segment `$1`, a program reaches it with an ordinary memory access, and a game
too big for the console's memory now puts its whole heap there. That is the NES's
`$6000` story with a different port, and it is the **elastic-cartridge rule
reaching the RAM** — a board brings what the game needs and the footer declares
the smallest of the five sizes it can name that holds it, exactly as every other
family takes the smallest board that holds its program.

`DS` and `ES` point at that segment for the length of the program, so the heap is
still what an unprefixed operand means: the 16.16 value layer, the expression
compiler, the rule bodies and the tile walk are **unchanged**, prefix for prefix,
on a game whose variables are in a cartridge. What moves instead is the short list
of addresses that are the display's rather than the allocator's — two screen maps,
the object shadow, the object table and the tile bank — and those are reached
through `SS`, which a demade cartridge already points at the console's memory for
its stack and never moves.

**The heap moves whole or not at all**, which is why this is a second memory plan
rather than the NES's `heapSpill`. A segment override reaches a memory operand and
even the source of a `movs`; the destination is `ES` and no prefix changes it, so
a copy between two heap addresses cannot have one end in each memory. Which one
"the heap" is has to be a single answer, and that is the same shape the segment
banking takes for the same kind of reason.

Every WonderSwan cartridge that fitted the console's own memory is byte-identical.

And a bug the segment banking shipped goes with it, because the test written for
the new one found it: on a **banked** cartridge every scene's backdrop was
unpacked from the wrong segment. `BlitBackdrop` is a pulled helper, so it lives in
the fixed segment and its `cs:` means the fixed segment however the scene that
called it got there — but the backdrop was being copied into each paged segment
like a level grid, and the helper read the fixed segment at that copy's offset.
On this cartridge that offset is `$FF` padding, and `$FF` is a run control byte,
so the blit unpacked runs of `$FFFF` upward through the screen maps and over the
stack until the return address was gone. It presented as a wild jump several
routines later and no trace could see it, because a picture is not state. The rule
the backend already runs under is unchanged and only its application moves: a
table goes in the segment of the code that reads it, and a backdrop's reader is
not the scene.
