---
"@demake/audio": minor
"demake": minor
---

Build a standalone Virtual Boy audio cartridge, on this project's tenth
processor.

`demake gen <schedule> -c vb --format rom` now produces a bootable `.vb` that
plays the schedule. It is the eighth standalone cartridge and the first that
arrives **with** its player rather than reusing one: `rom/v810-player.ts` is the
seventh stream player in the set and the first for this architecture, so what
`rom/vb.ts` owns is the three things a console decides for itself.

Three of those answers are this machine's.

**A packed register is a _port_, because this chip's registers do not fit in a
byte.** The VSU's address space is eleven bits — five waveform tables, a
modulation table and six channel blocks, all one region rather than a port and
an index — so a schedule's register number runs to `$7FF` and the packed format
spends one byte on it. What a stream carries is narrower: the tables are written
once at boot and stripped, leaving forty-nine values, so a channel and its
register pack into six bits and the driver takes them apart with two shifts.

**The clock is the picture, polled.** A demade Virtual Boy game takes no
interrupt anywhere — it reads `INTPND` for the drawing processor's own flag,
because a loop that waits either way gains nothing from a vector — and a
cartridge whose only job is a track has even less to gain. So this one polls
too, at 50.2 Hz: the slowest driver rate in the matrix, and the one
`vbBinding.fitRate` already returned.

**The waveform tables are the whole of why the boot prefix is stripped.** A
hundred and sixty writes through five tables is more than a packed run's count
byte holds, which is the PC Engine's reason rather than the Game Boy's — and a
channel enabled before its table is in place plays whatever powered up.

Three things about the player are the instruction set's. A call returns through
a register, so every routine puts its own return address away before it makes
one — no other player in the set needs that, because every other processor
pushes. There is no post-increment addressing, so walking packed data is a load
and an add. And a conditional branch reaches ±256 bytes against an
unconditional one's ±32 MiB, so a branch across the run walk — whose length
_is_ the schedule — inverts the condition over a jump.

Level A runs in `pnpm test` for it, in `@demake/vb`: an arranged track and a
demade sound effect, diffed tick for tick against the schedule with no
tolerance, plus the half no tick diff can see — that the five waveform tables
reached the chip before the clock started.
