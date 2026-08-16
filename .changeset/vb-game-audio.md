---
"@demake/audio": minor
"@demake/demotic": minor
"demake": minor
---

Play a game's music and effects on the Virtual Boy.

`demake build -c vb` now puts a **generated V810 driver** in the cartridge, so
the whole example library plays its music and its sound effects there and is
diffed tick for tick by the shared battery
(`packages/demotic/test/audio-vb.test.ts`). It is the eleventh generated driver,
the eighth processor to get one, and the last game console in the matrix to have
none — **all sixteen consoles that build a game now play their audio.**

Three things about it are this machine's rather than a predecessor's restated.

**The tick is a call, not a handler.** Every other frame-clocked driver in the
set is entered by an interrupt and counts what it is owed, because its main loop
can overrun a frame. This cartridge takes no interrupt anywhere: the loop builds
a frame, waits on the drawing processor and starts again, so a tick per pass _is_
a tick per frame and there is nothing to count. `AudioTick` sits at the bottom of
that loop, and `resolveVbClock` is the only clock resolver in the set with
exactly one answer to give — 50.2 Hz, the coarsest driver rate here.

**There is no merge arm at all**, the sixth console in the matrix with none and
the fourth whose reason is that its hardware shares _less_: panning is two
nibbles of a channel's own register, enabling is its own bit 7, and the one
global register is a panic button no stream writes. So the run format's merge bit
never appears in a schedule for this console and `shadowPlan` is handed no merge
set.

**Register liveness is the caller's question at every call**, which the eight
consoles with a push list are spared. A V810 routine saves its return address and
nothing else, and `AudioSfxRelease` reads the steal mask into the same register
both of its callers are holding something in — the request byte in one, the
effect's table entry in the other. `keep`/`unkeep` are that pair; without them an
effect is started from a pointer into whatever the release left behind, which is
a game whose sound never fires and whose music is otherwise perfect. Only the
battery's borrowed-channel case could see it.

The waveform tables go in the boot rather than tick zero, which is the PC
Engine's reason on different hardware — five tables is a hundred and sixty writes
through the register port and a packed run's count is seven bits — and they are
written directly rather than through the packed-write routine, because a port
byte is six bits of channel and register and wave RAM is neither.

Nothing outside this console moved: the memory plan, the emitter, the binding and
the player are all the Virtual Boy's, and the two registries that grew gained one
entry each. A Virtual Boy game that names no audio is unchanged as well, because
the allocator reserves a driver's state only for a program that has one.
