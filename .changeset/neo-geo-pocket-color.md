---
"@demake/demotic": minor
"@demake/core": minor
"@demake/ngp": minor
"@demake/chip": minor
"@demake/audio": minor
"@demake/web": minor
---

`demake build -c ngpc` builds a playable Neo Geo Pocket Color cartridge.

TLCS-900/H machine code written for the game, art demade into 2bpp characters
across fifteen four-colour palettes, and the whole example library traces
identically on it — in the same battery, at the same one frame per tick. The
ninth backend and the tenth processor, and the widest in the set: a 16.16 value
is a register here, so the only two routines this console pulls in are the
multiply and the divide.

Three things about it are the hardware's rather than a predecessor restated.
**The operand prefix comes before the opcode**, which is why `@demake/core`'s
decoder is two stages — a prefix names an operand _and its size_, and the opcode
after it says what to do. **A conditional branch never has to be inverted**,
because this is the only processor here with both a long conditional relative
branch and a conditional absolute jump. And **an interrupt handler is a pointer
in RAM**: the boot ROM owns the processor's own vector table, so a cartridge
installs a vertical-blank handler by writing four bytes.

The renderer writes almost nothing at all — **there is no video memory**, so the
tile bank reaches the display by one `ldir` and a cell is one store — into a
32×32 map against a 20×19 window on a plane that is exactly 256 pixels square,
which makes the scroll registers _be_ the wrap. What is this console's alone is
that a palette block belongs to a **layer**: sixteen four-colour palettes for the
objects and sixteen for each scroll plane, so a picture and its sprites can never
compete for one. And that the palette word is **BGR**, red in the low nibble,
which is the opposite of every other RGB444 console here.

`@demake/chip` models the T6W28 and `demake arrange`, `sfx` and `render` demake
this console's music and effects — on the mono machine too, because it has the
same sound hardware. Its stereo is a **level** rather than a switch: two
four-bit attenuators per channel, one a side, which makes this the fourth console
in the set with no shared register and the first to have none because its
hardware pans _more_. Two write ports carry different registers, so a driver
with them backwards produces silence rather than a wrong note.

What is not here yet is that driver: a cartridge for this console is silent, and
it traces identically to one that plays its music because a sound request is a
field of the trace. The page plays the cartridge in `@demake/ngp`, the tenth
owned core, byte-identical to the CLI's.
