---
"@demake/audio": minor
---

Build a standalone WonderSwan audio cartridge (doc 13 §A5).

`demake gen <schedule> -c wsc --format rom` now produces a bootable 512 KiB
cartridge that plays a `ChipScript` and does nothing else, and `-c ws` produces
the same one for the mono machine. The sixth family, and the fourth measurement
of the same claim: **the stream player is the processor's**. `wsc-driver.ts` was
not touched — a game already drove it — so what `rom/wsc.ts` owns is a boot
sequence, a clock and a cartridge wrapper, exactly as `sms.ts` and `pce.ts` do.

Doc 16's Level A proof runs on it in `pnpm test`: the cartridge boots in
`@demake/wsc` and every register write it makes is diffed against the schedule,
tick for tick, with no tolerance — for an arranged track and for a demade sound
effect, on both machines.

Three things are this console's, and each is a way a cartridge can assemble
perfectly and play nothing:

- **The clock is a tally, and here that is a fact about the _caller_ as well as
  the hardware.** This cartridge takes no interrupt — the controller vectors
  through the processor's own table in the first kilobyte of RAM — so the idle
  loop reads the vertical-blank timer's counter and pays whatever frames it
  finds owed. A game does the same from a loop that is also running a game, so
  its drift is bounded by a frame; this loop does nothing else, so it is bounded
  by a poll. The Mega Drive's `md.ts`-versus-`md-game.ts` distinction reached by
  different hardware, except that here it buys accuracy rather than a rate: the
  counter still only moves once a frame.
- **The waveforms are memory, so the boot copies rather than uploads.** Sixty-four
  bytes go from the cartridge into RAM at `WS_WAVE_BASE` and port `$8F` says
  where. That is why the chip's initialisation is stripped from the schedule and
  performed by the boot: a channel enabled before its table is in place plays
  whatever powered up at that address, which is a cartridge that is perfect in a
  register diff and wrong on the machine. A test asserts the bytes arrived, and
  it fails when the copy is removed.
- **The program is the last bank and the entry is a far jump.** The processor
  resets to `$FFFF:0000`, so `packWsRom` puts `jmp $F000:$0000` at `$FFF0` and a
  build is assembled at offset zero of a 64 KiB bank.

**Two machines, one byte.** A mono WonderSwan has the same sound hardware as a
Colour one — same chip, same ports, same waveform page in the same place — so
the driver, the binding and the schedule are one of each, and all this asks the
console is what to stamp in the footer's minimum-system field. That is `sms.ts`'s
bargain with a Game Gear's region nibble, and `@demake/dmg`'s CGB flag inverted.

The example track leaves 62328 of the mapped bank's 65520 bytes free.

`packages/cli/test/audio-level-b.e2e.test.ts` gains a row for it, so the same
cartridge is also compared with beetle-wswan's own samples where that core is
provisioned.
