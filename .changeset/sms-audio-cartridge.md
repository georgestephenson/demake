---
"@demake/audio": minor
"@demake/core": minor
"demake": minor
---

`demake gen <schedule> -c sms --format rom` builds a Sega cartridge, and `-c gg`
builds the same one for the other machine.

The fourth standalone audio cartridge, and the first that is _two_ consoles: a
Game Gear is a Master System whose sound chip has a stereo latch on a port of its
own, and a schedule already carries the writes to it — so the only thing this
backend asks the console is which region nibble to stamp, and `@demake/sms` reads
that nibble back to decide which machine plays it.

**Nothing about the player moved**, again. `rom/sms-driver.ts` was written for a
_game_ and is the Z80's rather than either machine's, so `rom/sms.ts` is the three
things a console decides for itself:

- **The clock is the picture's**, and there is genuinely nothing to choose (below).
- **There is no entry point and no vector table — there are addresses.** The Z80
  resets to `$0000` and takes a maskable interrupt to `$0038` in mode 1, so the
  boot, the frame handler and the Pause handler are not pointed at: they are
  _placed_, by padding the image out to the addresses the CPU will go to. A build
  that emitted them in a different order would still assemble.
- **The header is sixteen bytes inside the image**, at `$7FF0`, rather than a
  wrapper around it.

That last one needed a mechanism rather than a constant, and it is the one new
thing in the shared player. A cartridge here is 32 KiB or 48, and the elastic-
cartridge rule says a schedule takes the smaller board when it fits — but padding
the whole data section past the header, which is what the game backend does
because there the _code_ is what fills the region below it, would throw thirty-two
kilobytes away and leave the larger board **unreachable**: every schedule big
enough to need it would also be too big for what was left. So `emitStreamData`
takes a `DataHole` and steps the packed blocks over it. Blocks are addressed by
label, so a gap between two of them costs the gap and nothing else.

**And it found a clock that was never going to keep time.** These consoles have a
second interrupt and it looks like a timer — the VDP's line counter fires every
(N+1) scanlines — so `AudioSpec` listed `line-irq` among their driver sources and
`psgBinding.fitRate` returned one of those rates for any request above the frame.
The counter is _reloaded on every scanline outside the active display_, so an
interrupt programmed for every 65 lines fires twice inside the picture and then
not at all for seventy: two ticks a frame, in a burst, out of the four the rate
claims. A schedule fitted to 241.53 Hz is performed at 119.85 — half speed,
lurching once a frame, against a tempo requirement that says timing error must not
accumulate.

Nothing had ever consumed it. A game asks `gameDriverRate` and gets the frame, and
the reason recorded for keeping the candidate was that only a game shares its
clock with the picture — which is the wrong reason, because the reload is the
hardware's and does not care who is asking. The first standalone Sega cartridge is
what asked. **Both the candidate and the spec entry behind it are gone**, so this
chip's only clock is the frame on either kind of cartridge, and `demake sfx -c
sms` now fits to 59.92 Hz where it used to declare a rate it could not hold. That
is an output-byte change for `arrange`/`sfx`/`render` on `sms`, `gg` and `sg1000`
wherever the requested rate was above the frame.

**The proof is the Game Boy's, run in `@demake/sms`** — the same
`it.each(audioRomConsoles())` battery, a track and a one-shot per console, with no
tolerance. Two cases beside it are this machine's, and each catches something the
register diff cannot: the driver ticks **once a frame**, measured in CPU cycles,
because a handler that failed to acknowledge the VDP would re-enter the instant
`ei` ran and play the whole schedule in a few frames with every write correct and
in order; and no packed block overlaps `$7FF0`, because `packSegaRom` stamps eight
bytes of "TMR SEGA" over whatever is there.

[`console-support.md`](../docs/console-support.md)'s **audio ROM** column is where
which consoles do this is stated, so this note does not have to be.
