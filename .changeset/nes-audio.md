---
"@demake/audio": minor
"@demake/demotic": minor
---

Sound on the NES: a generated 6502 driver, and the page plays it

`demake build -c nes` now puts a game's music and effects in the cartridge. The
schedules are the same ones the audio engine already demakes; what is new is a
**generated 6502 driver** to perform them — the SM83 driver's counterpart, sharing
`data.ts`'s packed format and nothing below it. A game that names `music` and
`sound` no longer builds silent, and the NES backend's gap list is empty.

Three things are the console's own rather than the Game Boy's restated:

- **The clock is the picture's.** A 2A03 has no general-purpose timer a driver can
  have without burning the DMC channel, so a game's audio runs at the console's
  frame rate rather than at 120 Hz. Asking for a finer rate would not buy
  resolution — the driver would tick twice at the top of a frame and then not at
  all for sixteen milliseconds. `gameDriverRate` decides this in the package that
  owns the drivers. The NMI _counts_ frames into a capped byte and the main loop
  performs them, so the vertical blank stays the picture's and a frame the game
  overran is caught up rather than lost.
- **The shared register is `$4015`**, merged and never stored, exactly as `NR51`
  is on the Game Boy — and its four enable bits _are_ the four channel bits, so
  the fold is two `and`s with no nibble to swap. Clearing a bit is also how that
  chip silences a channel, so releasing a borrowed voice and stopping a track are
  both one recomputed byte.
- **The data pointer lives in page zero**, because `($nn),y` is the CPU's one
  indirection. The driver takes 23 bytes of it, from the same allocator everything
  else uses, and only for a program that names audio.

`packages/demotic/test/audio.test.ts` now runs its whole battery on both
machines: boot the cartridge, watch `AudioTick` by program counter, diff every
register write against the schedules the demakers produced, with no tolerance.
Running one battery over two drivers that share only a byte format is what makes
doc 16's contract a contract rather than a description of one emitter.

The web app's ROM pane plays it. The sound button is available on both consoles
now and follows the cartridge, rebuilding the stream against _that chip's_ clock —
4.19 MHz against 1.79 — through the same `StreamSink` and the same `@demake/chip`
models. The page still synthesizes nothing.

One example does not fit. The shooter's NES cartridge is **under two hundred bytes over** with
its music and effects in it, and `demake build -c nes` says so rather than
dropping anything. The audio is not what makes it tight — 1742 bytes there
against 2076 on the Game Boy, because the driver ticks at 60 Hz rather than 120 —
the game around it is: the same program's 6502 code is about 3.8 KiB larger than
its SM83 code, and an NES backdrop is a 960-cell nametable against a Game Boy's
360, with no mapper to spend the difference from. The conformance suite asserts
the overflow instead of skipping the fixture, so a codegen change that wins the
bytes back will fail that test and move it back into the sweep. The other six
examples all keep more than a kilobyte free.

The driver costs the web bundle about 1.5 KB gzipped, which leaves the site at
298 KB of its 300 KB budget (doc 07 §Quality bar) — under two kilobytes of room,
and the next thing that does not fit should be made smaller rather than given
more.

**Output bytes change** for `nes` cartridges built from a program that names
`music` or `sound`: the driver, its tables and its packed schedules are in the
ROM, and page zero moved by the bytes the driver reserves. Traces are unchanged
on every console, with or without the audio files supplied.
