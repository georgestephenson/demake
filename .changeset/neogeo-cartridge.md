---
"@demake/core": minor
"@demake/neogeo": patch
---

Add the Neo Geo cartridge: its program header, both graphics formats, and the
`.neo` container they ship in.

**A Neo Geo cartridge is not one ROM.** The board carries a P ROM the 68000
executes, an S ROM the fix layer reads and a C ROM _pair_ the sprite hardware
reads, on different buses, with no address space containing all of them. So "the
cartridge" is a set, and `packNeoRom` writes the documented single-file `.neo`
container — a header naming each region's length, then the regions end to end —
which keeps `demake build` writing one artifact the way every other console does.

Both graphics formats are peculiar in the same way and it is the reason the
encoders live in `core` rather than in a backend. **A sprite tile's four 8×8
blocks are stored top-right first** — (8,0), (8,8), (0,0), (0,8) — with planes 0
and 1 in the odd C ROM and 2 and 3 in the even one; **a fix tile is stored in
columns with its right half first**, two pixels to a byte and the left one in the
low nibble. Either would be wrong _and_ consistent if the encoder and the reader
were written together, which is the Neo Geo Pocket's BGR palette exactly
(AGENTS.md §Gotchas), so `packages/core/test/neo-cart.test.ts` pins them against
byte offsets computed by hand from the format description rather than against a
decoder of ours.

`@demake/neogeo` closes the loop from the other end: `loadNeo` splits a container
and **decodes** the packed graphics, so a cartridge is only proven to carry
hardware bytes because something unpacks them the hardware's way. The machine
tests run that round trip end to end with a pixel deliberately placed in the half
the C ROM stores second.

The header puts vertical blank at `$0064` — interrupt level 1's autovector, not
the level 6 a Mega Drive uses — and enters through the `JMP` at the documented
`USER` offset. The reset vector points at `USER` too: on a real board it would
point into the system ROM, which would call back through that table, and a demade
cartridge needs nothing the system ROM does, so pointing it at the same place
makes the image self-contained without changing what the hand-off reaches.

The one thing here taken from convention rather than a format description is the
C pair's byte interleave in the container, and it is isolated to a single
function so a correction is one edit.
