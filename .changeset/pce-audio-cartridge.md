---
"@demake/audio": minor
"demake": minor
---

`demake gen <schedule> -c pce --format rom` builds a HuCard.

The third standalone audio cartridge, and the one that turns the NES's claim into
a measurement: **the stream player is the processor's**. `rom/mos-player.ts` was
not touched — a HuC6280 _is_ a 6502, so the same walk that plays a 2A03 plays six
wavetables — and `rom/pce.ts` is the same three things a console decides for
itself, with different answers.

- **The clock is the CPU's own timer**, seven bits of reload at master ÷ 3 ÷
  1024, so this console gets the Game Boy's clock discipline rather than the
  NES's frame; a schedule fitted to anything else is refused by name.
- **The registers are somewhere else**, at `$0800` in the hardware page the boot
  code maps at logical zero, which is the whole of why the shared player takes a
  base rather than having one.
- **The program is not where it was assembled.** Reset maps only bank 0 at
  `$E000`, so the boot stub is emitted last, padded there, and the two halves of
  the window are swapped on the way into the image — a build that wrote them in
  the obvious order would boot into the middle of the packed schedule.

**And one thing neither predecessor needs.** This chip's wave RAM is reachable
only through the register port, so five waveforms is a hundred and sixty writes
and tick 0 arrives holding more writes than the packed format's run count can
carry. Stripping the chip's initialisation off the head of the stream and
performing it once, from a table, is therefore what makes a schedule _packable_
here — where on every other console it is merely what stops an effect powering
the chip up again each time it fires.

That makes the proof sharper rather than weaker. `BuiltAudioRom` now carries a
**`performed`** schedule — the same field, and the same reason, every game driver
in that directory already has one — and Level A diffs against it: what the driver
promises, not what the caller handed it. A second assertion covers the half no
tick diff can see, that the waveforms reached the chip _before_ the clock
started, because a cartridge that skipped the table would be exact in a register
diff and silent on the machine.

Both halves of the driver are now checked on every console that builds one: a
track and a one-shot, because where a stream _ends_ is the order walk's business.
[`console-support.md`](../docs/console-support.md)'s **audio ROM** column is where
which consoles do this is stated, so this note does not have to be.
