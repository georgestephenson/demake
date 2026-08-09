---
"@demake/demotic": minor
"@demake/audio": minor
"@demake/neogeo": minor
"@demake/core": minor
---

`demake build -c neogeo` puts the sound program in the cartridge. The Neo Geo is
the fifteenth console whose games play their own music and effects, and the
shared battery diffs every tick's writes against the schedules the demakers
produced.

The `.neo` container carries the M and V regions — a Z80 program and the two
ADPCM sample ROMs — and the 68000's whole share of the audio is **one byte stored
to `REG_SOUND`** at a scene change. There is no driver call, no shared memory and
nothing to wait for: the other processor is already running and takes it as a
non-maskable interrupt.

Three things about the wiring are this console's alone.

**A tick nothing is playing is not a tick.** This driver runs from boot whether or
not the game has asked for anything — it is a separate program, so there is nobody
to start it — and ticking through silence puts a schedule's tick 0 several ticks
after the first one the hardware delivered. Every other console is spared this
because its driver is a routine the game calls.

**The request can arrive before the driver is listening.** A 68000 boots in a few
hundred cycles and this program takes tens of thousands, so a game asking for its
entry scene's track asks first. The hardware latches the byte either way and only
the interrupt is lost, so the boot ends by reading the port — without which the
cartridge is silent until its second scene.

**One host step is not one instruction of the processor the driver runs on**, so
the conformance harness watches the Z80's instruction stream exactly as it watches
a Super Nintendo's sound processor. It also needed a **tick end**: this driver's
clock is a register on the chip it is playing, so the timer acknowledge is a chip
write between two ticks, and without a close it lands in the group of the tick
before it.

Two smaller fixes fell out. `needDrawFixNumber` named `PokeFix` instead of pulling
it, so a Neo Geo game whose HUD is a counter and no caption failed to assemble —
helpers are pulled, never pushed, and the reachability closure is what makes a
nested pull work. And `Sound` gained an observing chip tap, on `@demake/md`'s
terms: it reports what the hardware was told and changes nothing it sees.
