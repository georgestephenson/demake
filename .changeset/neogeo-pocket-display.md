---
"@demake/ngp": minor
---

`@demake/ngp` gets its picture and the machine around it.

The display controller is handed the console's video memory rather than owning
an array of its own, for `@demake/wsc`'s reason: on this machine the registers,
the palettes, the two scroll maps, the object table and the character bank are
one region of the same address space the variables are in, so nothing is ever
uploaded through a port and the display reads exactly what the processor wrote.

Four things about it are this hardware's rather than a restatement. **Three
sprite priorities interleave with two planes** — backdrop, the objects that chose
"furthest", the back plane, the objects that chose "middle", the front plane, and
the objects that chose "front", with one register deciding which plane is which
— so an object can be _between_ two background layers, which no other 8-bit
console in this project offers. **An object is one tile and a big one is a
chain**: there is no 8×16 and no size field, and two bits say "my position is an
offset from the previous object's", so a 16×16 character is four entries whose
last three are relative and an object's absolute position depends on every object
before it. **The leftmost pixel of a character is in the highest bit pair**,
which is the opposite way round from every packed format here. And **colour zero
is transparent everywhere**, so the backdrop is a register rather than a layer.

It is **both Neo Geo Pockets**, decided by a constructor argument the way
`@demake/wsc` is: the maps, the character bank, the object table, the scrolling
and the priority are identical, and only the palette lookup differs — three grey
shades in a four-byte table on the mono machine, sixteen four-entry RGB444
palettes per layer on the Color.

The machine's **boot ROM is ours**, on `@demake/snes`'s terms: SNK's is not
something this project ships, and what a cartridge needs is the documented
hand-off — read the entry address out of the header, point the stack, jump — plus
dispatching the vertical blank through the four bytes a cartridge writes into
RAM, because the processor's own vector table belongs to the boot ROM.

**Input is absent rather than half-implemented**, and it is a gap rather than a
decision: the controller status byte's bit layout is not in either hardware
reference this project could reach, and a machine description that is wrong _and
consistent_ passes every test there is (AGENTS.md §Gotchas). The sound processor
and the on-chip timers are absent on the same terms.
