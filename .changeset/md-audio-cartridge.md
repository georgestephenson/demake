---
"@demake/audio": minor
"@demake/chip": minor
"@demake/md": minor
"demake": minor
---

`demake gen <schedule> -c md --format rom` builds a Mega Drive cartridge.

The fifth standalone audio cartridge, and the one where **a standalone cartridge
stops being a game with the game taken out**.

Nothing about the player moved, for the fourth time: `rom/md-driver.ts` was
written for a game and belongs to the 68000, so `rom/md.ts` is a boot sequence, a
clock and a cartridge wrapper. But the clock is one a _game_ on this console
cannot have, and the reason is not the hardware's — it is the caller's. The
YM2612's timer A is a real programmable clock, and on this board its interrupt
line goes to the Z80 rather than to the 68000, so a driver has to poll the status
byte. A game polls it once per pass of a loop that is also running a game, and
keeps the loop's rate. A cartridge whose loop does nothing else polls every few
microseconds and keeps the timer's rate exactly, with the drift bounded by one
poll rather than by one frame. So `resolveMdClock` and `resolveMdAudioClock`
refuse **opposite** sources, and each names which caller it is.

Two things follow that no other console needs.

- **The boot prefix has to be stripped**, and this is the third distinct reason a
  console strips one. `binding/md.ts`'s initialisation writes `$27 = 0` — "no
  timers, channel 3 in normal mode" — and `$27` is the timer control register the
  driver programmes. Left at the head of the stream, tick 0 would switch off the
  clock that was about to deliver tick 1. On a Game Boy the strip merely stops an
  effect powering the chip up again; on a PC Engine it is what makes a schedule
  packable at all; here it is what keeps the cartridge running.
- **The overflow is acknowledged with the run bit still set**, so the counter is
  never reloaded — the hardware only reloads on a clear-to-set transition. Clear
  and restart instead and the poll's own latency is lost from the tempo every
  tick, for ever.

**And it found a chip that was only running when somebody was listening.**
`@demake/md` advanced the FM chip only while a sample sink was attached, which is
indistinguishable from always advancing it for a chip nothing can read — and every
other chip in the set is write-only, so nothing had ever noticed. This one has a
status byte carrying the two timer overflow flags, and a driver whose clock is
timer A polls exactly that. Gated on a sink, the cartridge would spin for ever on
a flag nothing could set. `Ym2612.run`'s sink is now optional and the console
clocks the chip unconditionally: a timer is not audio, and a model that stops when
the speakers are unplugged is a model of the speakers. The PSG keeps the old
arrangement, because nothing can read it.

**The proof is the Game Boy's, run in `@demake/md`** — the same
`it.each(audioRomConsoles())` battery, a track and a one-shot, no tolerance — and
it is the first target with _two_ chips, so a captured write now carries which one
it addressed. That is not bookkeeping: `$25` is the FM chip's timer reload and the
PSG's one write port at once, so a register number identifies nothing here on its
own.

It also made the harness's tick attribution honest. A group ran from one `Tick`
entry to the next, which equals "the writes this tick made" only while nothing
writes the chip _between_ ticks — true on five consoles and false on this one,
where the acknowledge does. A driver may now name a `TickEnd` label, which adds no
instruction and leaves the ROM unchanged, and the group closes there.

Three cases beside the diff catch what it cannot see: that the program was
assembled where the cartridge _puts_ it (assembled at zero it has a perfect symbol
table and jumps two hundred bytes short of everything, which is a cartridge that
boots and executes its own title), that no tick writes `$27`, and that the tick
spacing is the timer's period in CPU cycles rather than anything the loop happens
to take.

[`console-support.md`](../docs/console-support.md)'s **audio ROM** column is where
which consoles do this is stated, so this note does not have to be.
