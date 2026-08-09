---
"@demake/audio": minor
"@demake/core": patch
---

Generate the Neo Geo's sound program — the eighth driver, and the first that is a
**cartridge region of its own**.

Every other driver in the set is routines a game calls, a block the cartridge
uploads, or a second binary in memory both processors share. This one is a whole
Z80 program in the M region, on a bus the 68000 cannot see: it boots itself,
clocks itself, and the game reaches it by storing one byte to `REG_SOUND`.

**The clock is the chip's own timer, and the interrupt comes here.** A Mega Drive
has exactly this hardware with the wire the other way round — there the YM2612's
timer line goes to the Z80, so a _game_ has to poll from a loop that is also
running a game and gets the loop's rate rather than the timer's. Here the driver
_is_ the Z80, so it takes the interrupt directly and keeps 119.99 Hz exactly. The
handler still only counts; the main loop pays what the counter says.

**A request is an interrupt rather than a poll**, so asking for a track costs one
store with no handshake and no shared memory. **An effect borrows a square, never
an FM voice** — which is why `neogeoAudio` lists the squares first, and it buys
something concrete: the FM key-on byte names its channel in the _datum_, which an
address byte cannot know, so an effect on an FM voice would need a tag that cannot
be computed.

Two chip facts shape the write loop. **A write has to settle** — seventeen chip
cycles after an address and eighty-three after a datum, which the hardware
documentation warns is why some homebrew plays in an emulator and not on a board —
so the write pads with two `push af`/`pop af` pairs and nothing is clobbered. And
**the register is latched**, so the channel tag is a factory carrying it, and an
address byte is tagged with the channels of the register it is about to latch:
that keeps an address and its datum in one run, where tagging the address as
nobody's would split every register write in half. `checkAddressDiscipline`
refuses a schedule where a run would not open with an address.

Two tags rather than one, which is this console's own: preemption asks which of
four borrowable channels a run is on, and restriction asks which of _fourteen_
voices a write belongs to. Numbering only the borrowable ones for both keeps an
effect's whole opening statement of the chip, which is a sound effect that
silences the music every time it fires.

A borrowed channel is not replayed on handback, beside the Mega Drive's and for a
second reason on top of that one: an FM voice's state is a whole patch, so a
general replay is thirty registers rather than three. Recorded in doc 13 rather
than pretended about.
