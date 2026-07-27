---
"@demake/audio": minor
"@demake/demotic": minor
"@demake/sms": minor
---

Sound on the Sega 8-bits: a generated Z80 driver for the SN76489

`demake build -c sms` and `-c gg` now put a game's music and effects in the
cartridge. The schedules are the same ones the audio engine already demakes; what
is new is a **generated Z80 driver** to perform them — the SM83 and 6502 drivers'
counterpart, sharing `data.ts`'s packed format and nothing below it. A game that
names `music` and `sound` no longer builds silent, and the Sega backend's one
named gap is closed.

This is the console that stretched the shared layer, and three things about it are
the chip's own rather than either predecessor's restated:

- **The channel is in the data byte, and it is latched.** Both other chips say
  which voice a write belongs to in the register's address; an SN76489 has one
  write port and says it in the top bits of the value — and only in _some_ values,
  because a byte with bit 7 clear continues whatever the byte before it selected.
  So `PackOptions.channelOf` is now a **factory** for a `(reg, value)` tag carrying
  a per-schedule latch: two calls to `packScript` sharing one would tag the second
  stream's opening bytes from the first stream's last write. Preemption skips whole
  _runs_ rather than writes, which is what makes it safe here — every run of a PSG
  stream opens with a latch byte, so a run the music skips takes its own selection
  with it. That property is checked rather than assumed, and a schedule whose tick
  opens with a bare data byte is refused with `E_PSG_LATCH`.
- **The clock is the frame, and the line interrupt is not a clock.** `AudioSpec`
  lists `line-irq` among these consoles' sources and `psgBinding.fitRate` will
  return rates a long way above the frame — but the VDP reloads its line counter
  on every scanline _outside_ the active display, so an interrupt programmed for
  every N lines fires a handful of times inside the picture and then not at all
  until the next frame. That is a raster effect, not a tempo. A game's driver
  therefore runs at 59.92 Hz, and `fitRate` now treats the frame as the candidate
  every other clock has to beat rather than as a fallback for when none is in
  range. The frame interrupt _counts_ into a capped byte and the main loop
  performs what it says, so the blanking interval stays the picture's.
- **The shared register exists on only one of the two machines.** A Master System's
  PSG has four independent attenuation latches and nothing carrying more than one
  channel, so there is no byte for one stream to erase the other's half of and no
  merge routine anywhere in the cartridge. A Game Gear is the same chip with a
  stereo latch beside it — every channel's left and right enables, four bits apart,
  `NR51`'s exact shape — and the merge comes straight back, expanded by one
  instruction because the Z80 has no `swap`. That is the only thing in the driver
  that differs between the two consoles.

A fourth difference is the CPU's rather than the chip's: `out (c), a` is the Z80's
one register-indirect way into I/O space, so the packed data carries the **port**
where the other two carry a register number (`PackOptions.port`). Same byte, and
the write loop pays nothing to translate.

`packages/demotic/test/audio.test.ts` now runs its whole battery on three
machines: boot the cartridge, watch `AudioTick` by program counter, diff every
register write against the schedules the demakers produced, with no tolerance. The
Game Gear gets a short block of its own for the stereo latch, which is the only
path the Master System's pass does not already run. `Sms.psgTap` reports the
register alongside the byte, because a stereo write and a note are different
devices.

**Two bug fixes come with it.** `AudioSfxRelease` held its channel mask in `b`,
which `AudioMusicStart` uses to carry the track it was asked for — so on the Game
Boy, a scene change that happened while a sound effect was playing started
whichever track the effect's channel mask happened to name, or started one where
the scene asked for silence. The mask moves to `c`, which is dead by then. And a
build's reported driver and schedule sizes were read before the driver had been
emitted, so `demake build` said "0 bytes of driver" on every console; they are
getters over the driver's own stats now.

One example does not fit, and it is the same debt the NES paid off one commit
ago. The shooter's Master System cartridge is about a kilobyte over with its music
and effects in it. The audio is not what makes it tight — its PSG schedule is the
smallest of the three consoles', because the chip has fewer registers to state and
the driver ticks at the frame. What makes it tight is that this backend still
emits a copy of a rule's code per object: measured on that fixture, collisions are
9,283 bytes, the integrator 2,840 and the edge rules 2,894, out of 33,754. Nine
aliens against three shots is twenty-seven collision pairs and each one is the
same program with a different address in it — exactly what `perf(nes): loop a rule
over its objects` folded from 12,217 bytes to 2,472 on the other machine.

So the overflow is asserted rather than skipped, and the Sega sweep asserts 512
bytes of headroom where the other consoles assert a kilobyte (the caves lands at
986). Both are marked in `audio.test.ts` as a debt against the looping work rather
than as a fact about the hardware — the day that lands here, the assertion flips
and the fixture rejoins the sweep at the same kilobyte as everywhere else.

The web bundle absorbs it: 297.2 KB gzipped of the 300 KB budget (doc 07 §Quality
bar), which is where it was before. The driver is generated code inside
`core.worker`, which already bundles `@demake/audio` and the Z80 assembler for the
Sega game backend — so what a third driver adds is an emitter, not a dependency.

**Output bytes change** for `sms` and `gg` cartridges built from a program that
names `music` or `sound`: the driver, its tables and its packed schedules are in
the ROM, and work RAM moved by the bytes the driver reserves. They change for `gb`
and `gbc` cartridges with both music and effects, by the one-register fix above.
And `arrange`/`sfx` output changes for `sms`, `gg` and `sg1000` where the
requested driver rate is closer to the console's frame rate than to any line
interrupt it can produce — below about 61 Hz — because those now fit to the frame
rather than to a line interrupt that could not have held them. Traces are
unchanged on every console, with or without the audio files supplied.
