/**
 * The Neo Geo's sound side: a Z80, a YM2610, and a letterbox between them.
 *
 * This is the third console in the set whose sound runs on a processor of its
 * own, and it is the most separate of the three. A Super Nintendo's SPC700 is
 * *uploaded* through four mailbox bytes at boot; a Nintendo DS's ARM7 is the
 * cartridge's other binary in memory both processors share. This Z80 has **its
 * own ROM on its own bus** and is running before the 68000 has done anything at
 * all — the two processors share exactly one byte in each direction, and nothing
 * else about either is visible to the other.
 *
 * Four things follow, and each is why a demade cartridge's sound is shaped the
 * way it is.
 *
 *   - **The clock is the chip's own timer, and the interrupt comes here.** A Mega
 *     Drive has the same arrangement with the wire the other way round: there the
 *     YM2612's timer line goes to the Z80 and the *game* has to poll it from a
 *     loop that is also running a game. Here the driver is the Z80, so it takes
 *     the interrupt directly and keeps the timer's rate exactly.
 *   - **A request is an NMI.** The 68000 writes one byte to `REG_SOUND` and the
 *     hardware latches it and pulls this processor's non-maskable line, so a game
 *     asking for a track costs one store and no handshake. Reading port `$00`
 *     takes the byte *and* acknowledges.
 *   - **The picture is invisible from here.** No vertical blank reaches this
 *     processor, which is what makes `neogeoAudio`'s `driver.sources` name one
 *     entry where every other console lists the frame among its options.
 *   - **The program lives in the fixed window.** `$0000`-`$7FFF` is the first
 *     32 KiB of the M ROM and does not move; the four windows above it are
 *     banked, and a driver that fits below `$8000` writes no bank port at all.
 *     This model maps them linearly so that a program which *did* would still see
 *     a flat image, which is what the hardware documentation's own example
 *     arranges.
 *
 * The bank registers, the second half of the port map and the Z80's own
 * `RESET`/`HALT` lines from the 68000 are absent rather than half-implemented, on
 * the terms the rest of this package states its gaps.
 *
 * Sources:
 * - Neo Geo Development Wiki — Z80: https://wiki.neogeodev.org/index.php?title=Z80
 * - Neo Geo Development Wiki — Z80/YM2610 interface:
 *   https://wiki.neogeodev.org/index.php?title=Z80/YM2610_interface
 * - Neo Geo Development Wiki — 68k/Z80 communication:
 *   https://wiki.neogeodev.org/index.php?title=68k/Z80_communication
 */

import { Ym2610, YM2610_CLOCK_HZ, type SampleSink } from "@demake/chip";
import { Z80, type Bus } from "@demake/sms";

/** The sound processor's clock: the 24 MHz crystal over six. */
export const Z80_HZ = 4_000_000;

/** The chip's, which is the same crystal over three. */
export const YM_HZ = YM2610_CLOCK_HZ;

/** 68000 cycles in one Z80 T-state: 12 MHz over 4. */
const CYCLES_PER_STATE = 3;

/** Chip cycles in one Z80 T-state: 8 MHz over 4. */
const STATES_PER_CHIP_CYCLE = 2;

/** The fixed window: the first 32 KiB of the M ROM, which never moves. */
export const FIXED_WINDOW = 0x8000;

/** Work RAM: two kilobytes at the top of the address space. */
export const SOUND_RAM_BASE = 0xf800;
export const SOUND_RAM_SIZE = 0x0800;

/**
 * The ports a demade cartridge uses, and what each is.
 *
 * `$04`-`$07` are the chip's four bus addresses in the order a driver stores
 * them: an address and a datum for the pair carrying the SSG, ADPCM-B and FM
 * channels 1-2, then the same for the pair carrying ADPCM-A and FM channels 3-4.
 */
export const SOUND_PORT = {
  /** Read: the byte the 68000 sent, and the NMI acknowledge. */
  command: 0x00,
  addressA: 0x04,
  dataA: 0x05,
  addressB: 0x06,
  dataB: 0x07,
  /** Read: allow the next command to raise an NMI. */
  enableNmi: 0x08,
  /** Write: the byte the 68000 can read back. */
  reply: 0x0c,
  /** Read: refuse it. */
  disableNmi: 0x18,
} as const;

/** The Z80's side of the board. */
export class Sound implements Bus {
  readonly cpu: Z80;
  readonly chip: Ym2610;
  readonly ram = new Uint8Array(SOUND_RAM_SIZE);

  /** The byte the 68000 last sent, which port `$00` reads. */
  command = 0;
  /** The byte this processor last replied with, which the 68000 can read. */
  reply = 0;
  /** Whether a command may raise a non-maskable interrupt. */
  nmiEnabled = false;

  /**
   * Where the chip's output goes, if anywhere.
   *
   * Absent by default, because the chip has to be *clocked* whether or not
   * anything is listening — its timer is a register the driver reads, which is
   * the Mega Drive's rule arrived at from the other side of the same wire.
   */
  audioSink: SampleSink | undefined;

  private readonly rom: Uint8Array;
  /** A command that arrived and has not yet been taken by the handler. */
  private nmiPending = false;
  /** 68000 cycles this processor has been handed and not yet spent. */
  private debt = 0;

  constructor(rom: Uint8Array, samplesA: Uint8Array, samplesB: Uint8Array) {
    this.rom = rom;
    this.chip = new Ym2610({ pcmA: samplesA, pcmB: samplesB });
    this.cpu = new Z80(this);
    this.cpu.reset();
  }

  /**
   * The 68000 sent a byte, which is the whole of the request protocol.
   *
   * Latched whether or not the interrupt is allowed, because the hardware latch
   * is in front of the enable — a driver that has masked itself still finds the
   * byte waiting when it reads port `$00`.
   */
  send(value: number): void {
    this.command = value & 0xff;
    if (this.nmiEnabled) this.nmiPending = true;
  }

  // --- bus -------------------------------------------------------------------

  read(address: number): number {
    const at = address & 0xffff;
    if (at >= SOUND_RAM_BASE) return this.ram[at - SOUND_RAM_BASE] ?? 0;
    return this.rom[at] ?? 0xff;
  }

  write(address: number, value: number): void {
    const at = address & 0xffff;
    // Everything below the work RAM is ROM, so a store there is dropped rather
    // than raising: a driver with a bug should sound wrong, not throw.
    if (at >= SOUND_RAM_BASE) this.ram[at - SOUND_RAM_BASE] = value & 0xff;
  }

  in(port: number): number {
    const at = port & 0xff;
    if (at === SOUND_PORT.command) {
      // Reading takes the byte *and* acknowledges, which is why a driver never
      // has to write anything to clear the interrupt.
      this.nmiPending = false;
      return this.command;
    }
    if (at === SOUND_PORT.enableNmi) {
      this.nmiEnabled = true;
      return 0;
    }
    if (at === SOUND_PORT.disableNmi) {
      this.nmiEnabled = false;
      return 0;
    }
    // Any of the chip's four addresses reads the same status byte, which is what
    // the hardware does and what a driver polling a timer would see.
    if (at >= SOUND_PORT.addressA && at <= SOUND_PORT.dataB) return this.chip.read();
    return 0xff;
  }

  out(port: number, value: number): void {
    const at = port & 0xff;
    if (at >= SOUND_PORT.addressA && at <= SOUND_PORT.dataB) {
      this.chip.write(at - SOUND_PORT.addressA, value);
      return;
    }
    if (at === SOUND_PORT.reply) this.reply = value & 0xff;
  }

  // --- running ---------------------------------------------------------------

  /**
   * Run for `cycles` of the *68000's* clock, which is what a caller has.
   *
   * The three clocks are 12, 4 and 8 MHz, which divide exactly: one Z80 T-state
   * is three of the 68000's and two of the chip's, so nothing here is fractional
   * and no remainder has to be carried.
   *
   * **The chip is advanced between instructions rather than in a lump**, and that
   * is the whole of what this loop has to get right. A caller hands over a frame's
   * worth of cycles at a time; advancing the chip by all of them first would run
   * hundreds of timer overflows into one flag, and the driver would take *one*
   * interrupt where the hardware gives it hundreds. Its music would play at the
   * rate the caller happened to poll at, which is a tempo nobody chose and a bug
   * no register diff can see.
   */
  run(cycles: number): void {
    this.debt += cycles;
    while (this.debt >= CYCLES_PER_STATE) {
      this.debt -= this.stepZ80() * CYCLES_PER_STATE;
    }
  }

  /** One Z80 instruction or interrupt, and the chip cycles beside it. */
  private stepZ80(): number {
    let states = 0;
    // A non-maskable interrupt outranks the timer, and neither can land in the
    // middle of an instruction — which is the Z80's own rule, and the reason the
    // driver's handlers need save nothing the CPU has not already saved.
    if (this.nmiPending) {
      this.nmiPending = false;
      states = this.cpu.nmi();
    } else if (this.chip.read() !== 0) {
      // Level triggered, deliberately: the chip holds its overflow flag until the
      // driver clears it, so a handler that forgot to would be re-entered for
      // ever. That is what the hardware does, and modelling it as an edge would
      // hide exactly the bug the Sega cartridge's tempo case exists to catch.
      states = this.cpu.interrupt();
    }
    if (states === 0) states = this.cpu.step();
    this.chip.run(states * STATES_PER_CHIP_CYCLE, this.audioSink ?? SILENT);
    return states;
  }
}

/** A sink that hears nothing, for a machine nobody is listening to. */
const SILENT: SampleSink = {
  clocksUntilSampleBoundary: (): number => Number.MAX_SAFE_INTEGER,
  add: (): void => {},
};
