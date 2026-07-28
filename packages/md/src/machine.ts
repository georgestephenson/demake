/**
 * The console around the processor: memory map, VDP ports, controllers.
 *
 * The Mega Drive counterpart of `@demake/dmg`'s `Gameboy`, `@demake/nes`'s `Nes`
 * and `@demake/sms`'s `Sms`, for the same two jobs (doc 14 §Conformance, doc 07
 * §no CDN): boot a `demake build` cartridge in Vitest with no toolchain and no
 * emulator install, and play one in the page without fetching a core from
 * anywhere.
 *
 * Both sound chips are here, because a `demake build` cartridge plays both: the
 * SN76489 at `$C00011` and the YM2612 at `$A04000`, each `@demake/chip`'s model
 * rather than a second implementation of it. What is absent is the Z80 that
 * would normally drive them — nothing here emits one — so its address space
 * answers as ordinary RAM and its bus-request registers answer "granted", which
 * is what a 68000-only program needs and is why it can reach the FM bus at all.
 *
 * Two other omissions are deliberate rather than pending:
 *
 *   - **No DMA.** A game uploads its tile bank a word at a time at boot and its
 *     sprite table a word at a time in the blanking interval, because both fit
 *     and because a DMA from work RAM has a refresh hazard that would have to be
 *     modelled to be trusted. The VDP's DMA registers are stored and ignored.
 *   - **A 64 KiB work RAM, mirrored.** `$FF0000`–`$FFFFFF` is the whole of it,
 *     and the mirror is what makes the top half reachable by the two-byte
 *     absolute form the memory plan is built around.
 *
 * Sources: Sega — Genesis Software Manual (§2 memory map, §5 controllers) and
 * Plutiedev's I/O notes (https://plutiedev.com/io-ports, https://plutiedev.com/psg-chip).
 */

import { Sn76489, Ym2612, type SampleSink } from "@demake/chip";

import { type Bus, M68k, VECTOR } from "./cpu.js";
import { CYCLES_PER_LINE, FRAME_HEIGHT, FRAME_WIDTH, LINES_PER_FRAME, Vdp } from "./vdp.js";

export { FRAME_HEIGHT, FRAME_WIDTH };

/** CPU cycles in one NTSC frame. */
export const FRAME_CYCLES = LINES_PER_FRAME * CYCLES_PER_LINE;

/**
 * The abstract buttons, and where they are on a three-button pad.
 *
 * This is the one console in the set whose pad has every button the portable
 * vocabulary names: a real Start, and A and B where the language expects them.
 * `c` exists on the hardware and the language has no word for it, so it reads as
 * released.
 */
export const BUTTONS = ["up", "down", "left", "right", "a", "b", "start"] as const;

/** One controller button. */
export type Button = (typeof BUTTONS)[number];

/** A Mega Drive with a cartridge in it. */
export class Md implements Bus {
  readonly cpu = new M68k(this);
  readonly vdp = new Vdp();
  /** The tone half of the sound hardware — `@demake/chip`'s model, not a copy. */
  readonly psg = new Sn76489();
  /** The FM half: six four-operator voices at `$A04000`. */
  readonly ym = new Ym2612();
  /** The whole cartridge image. */
  readonly rom: Uint8Array;
  /** The console's 64 KiB, which is the whole of a game's state. */
  readonly ram = new Uint8Array(0x10000);
  /** The sound CPU's memory, which nothing this project emits ever touches. */
  readonly z80ram = new Uint8Array(0x2000);

  /** Frames completed since power-on — the harness's clock. */
  frames = 0;

  /**
   * Called for every write the CPU makes to the sound chip.
   *
   * The audio conformance oracle's whole interface to the machine (doc 16 §The
   * proof, Level A), and `@demake/sms`'s `psgTap` exactly: it observes rather
   * than intercepts, because an oracle that changed what the hardware saw would
   * be testing itself. The register it reports is `@demake/chip`'s numbering,
   * which is a `ChipScript`'s — `0` for this chip's one write port.
   */
  psgTap: ((reg: number, value: number) => void) | undefined = undefined;

  /**
   * The same, for the FM chip.
   *
   * Its "register" is the *port*, 0-3, because that is what the bus has and what
   * a driver stores to: two addresses latch and two write. A tap that reported a
   * decoded register number would be inventing a view the hardware does not have,
   * and the schedule it is diffed against does not have one either.
   */
  ymTap: ((port: number, value: number) => void) | undefined = undefined;

  /**
   * Where the PSG's samples go, when anything is listening.
   *
   * Unset, the chip still receives every write and keeps its state; it is only
   * *rendered* when a sink is attached, so the conformance suites pay nothing for
   * hardware they never listen to.
   */
  audioSink: SampleSink | undefined = undefined;

  /**
   * Where the FM chip's samples go.
   *
   * A second sink rather than one, because the two chips run in different clock
   * domains — master over seven against master over fifteen — and a sink owns the
   * mapping from clocks to samples. Mixing them is the caller's, on the same
   * terms `render()` mixes the two halves of a schedule.
   */
  ymSink: SampleSink | undefined = undefined;

  private held = 0;
  /** The controller's TH line, which selects which half of the pad is reported. */
  private th = 0x40;
  private cycles = 0;
  private line = 0;
  /**
   * Chip clocks owed the PSG, in units of one seven-thousandth of nothing.
   *
   * The two clocks are the master clock divided by seven (the 68000) and by
   * fifteen (the PSG), so one CPU cycle is exactly 7/15 of a chip clock and the
   * ratio has a remainder. Carrying the numerator across calls is what keeps it
   * exact: rounding per call would drift by a few hundred clocks a second, which
   * is inaudible and would still make two runs of the same ROM disagree.
   */
  private psgOwed = 0;

  constructor(rom: Uint8Array) {
    if (rom.length < 0x200) throw new Error("md: a cartridge is at least 512 bytes");
    this.rom = rom;
    this.cpu.reset();
  }

  /** The picture the console's screen shows, as RGBA. */
  get framebuffer(): Uint8ClampedArray {
    return this.vdp.view().pixels;
  }

  // --- bus -------------------------------------------------------------------

  /** Fold a 32-bit address onto the console's 24-bit bus. */
  private static map(address: number): number {
    return address & 0xffffff;
  }

  read8(address: number): number {
    const at = Md.map(address);
    if (at < 0x400000) return this.rom[at] ?? 0xff;
    if (at >= 0xff0000) return this.ram[at & 0xffff] as number;
    if (at >= 0xa04000 && at <= 0xa04003) return this.ym.read();
    if (at >= 0xa00000 && at < 0xa04000) return this.z80ram[at & 0x1fff] as number;
    if (at >= 0xa10000 && at <= 0xa1001f) return this.readIo(at);
    if (at >= 0xa11100 && at <= 0xa11201) return 0x00;
    if (at >= 0xc00000 && at <= 0xc0001f) {
      const word = this.readVdp(at & ~1);
      return (at & 1) === 0 ? (word >> 8) & 0xff : word & 0xff;
    }
    return 0xff;
  }

  read16(address: number): number {
    const at = Md.map(address) & ~1;
    if (at < 0x400000) return ((this.rom[at] ?? 0xff) << 8) | (this.rom[at + 1] ?? 0xff);
    if (at >= 0xff0000) {
      return ((this.ram[at & 0xffff] as number) << 8) | (this.ram[(at + 1) & 0xffff] as number);
    }
    if (at >= 0xa00000 && at < 0xa04000) {
      return (
        ((this.z80ram[at & 0x1fff] as number) << 8) | (this.z80ram[(at + 1) & 0x1fff] as number)
      );
    }
    if (at >= 0xa10000 && at <= 0xa1001f) return this.readIo(at | 1);
    if (at >= 0xa11100 && at <= 0xa11201) return 0x0000;
    if (at >= 0xc00000 && at <= 0xc0001f) return this.readVdp(at);
    return 0xffff;
  }

  write8(address: number, value: number): void {
    const at = Md.map(address);
    if (at >= 0xff0000) {
      this.ram[at & 0xffff] = value & 0xff;
      return;
    }
    if (at >= 0xa04000 && at <= 0xa04003) {
      this.writeYm(at & 3, value & 0xff);
      return;
    }
    if (at >= 0xa00000 && at < 0xa04000) {
      this.z80ram[at & 0x1fff] = value & 0xff;
      return;
    }
    if (at >= 0xa10000 && at <= 0xa1001f) {
      this.writeIo(at, value & 0xff);
      return;
    }
    if (at >= 0xc00000 && at <= 0xc0001f) {
      // A byte write to a word port duplicates the byte into both halves, which
      // is what the PSG port at `$C00011` relies on.
      this.writeVdp(at & ~1, ((value & 0xff) << 8) | (value & 0xff));
    }
  }

  /**
   * One byte to the FM chip.
   *
   * Four addresses, and the 68000 reaches them directly because nothing here
   * emits a Z80 to contend for the bus. On hardware a program has to hold the
   * Z80's bus request first, which is what the boot code does; a core that
   * enforced it would be modelling an arbiter no demade cartridge can lose to.
   */
  private writeYm(port: number, value: number): void {
    this.ym.write(port, value);
    this.ymTap?.(port, value);
  }

  write16(address: number, value: number): void {
    const at = Md.map(address) & ~1;
    if (at >= 0xff0000) {
      this.ram[at & 0xffff] = (value >> 8) & 0xff;
      this.ram[(at + 1) & 0xffff] = value & 0xff;
      return;
    }
    if (at >= 0xa00000 && at < 0xa04000) {
      this.z80ram[at & 0x1fff] = (value >> 8) & 0xff;
      this.z80ram[(at + 1) & 0x1fff] = value & 0xff;
      return;
    }
    if (at >= 0xa10000 && at <= 0xa1001f) {
      this.writeIo(at | 1, value & 0xff);
      return;
    }
    if (at >= 0xc00000 && at <= 0xc0001f) this.writeVdp(at, value & 0xffff);
  }

  private readVdp(at: number): number {
    const port = at & 0x1f;
    if (port < 0x04) return this.vdp.readData();
    if (port < 0x08) return this.vdp.readControl();
    // The H/V counter. Nothing a game compiles to reads it, and returning the
    // raster's real position costs nothing.
    if (port < 0x0a) return ((this.line & 0xff) << 8) | 0x00;
    return 0x0000;
  }

  private writeVdp(at: number, value: number): void {
    const port = at & 0x1f;
    if (port < 0x04) {
      this.vdp.writeData(value);
      return;
    }
    if (port < 0x08) {
      this.vdp.writeControl(value);
      return;
    }
    // `$C00011` is the PSG — an eight-bit device inside the VDP's address range,
    // reached on the *odd* byte, which is why `write8` duplicates a byte into
    // both halves of the word before it arrives here. Taking the low half is
    // therefore right for a byte write to either address and for the word write
    // nothing this project emits ever makes.
    if (port >= 0x10 && port < 0x18) {
      const byte = value & 0xff;
      this.psg.write(0, byte);
      this.psgTap?.(0, byte);
    }
  }

  // --- controllers -----------------------------------------------------------

  /**
   * Player one's pad, read through the TH line.
   *
   * With TH high the port reports `1CBRLDU`; with it low, `0SA00DU` — so a
   * program that wants Start and A has to drive the line low first. Active low
   * on both halves, as on every pad in this project.
   */
  private readIo(at: number): number {
    if ((at & 0x1f) === 0x03) {
      const bit = (name: Button): number =>
        (this.held & (1 << BUTTONS.indexOf(name))) !== 0 ? 0 : 1;
      if (this.th !== 0) {
        return (
          0x40 |
          (bit("right") << 3) |
          (bit("left") << 2) |
          (bit("down") << 1) |
          bit("up") |
          (bit("b") << 4) |
          // `c` has no word in the language, so it reads as released.
          (1 << 5)
        );
      }
      return (bit("start") << 5) | (bit("a") << 4) | (bit("down") << 1) | bit("up");
    }
    if ((at & 0x1f) === 0x01) return 0xa0; // version register: an overseas Mega Drive
    return 0x00;
  }

  private writeIo(at: number, value: number): void {
    if ((at & 0x1f) === 0x03) this.th = value & 0x40;
  }

  // --- running ---------------------------------------------------------------

  /** Which buttons are down, by the abstract names the language uses. */
  setButtons(down: readonly string[]): void {
    let held = 0;
    for (const [index, name] of BUTTONS.entries()) {
      if (down.includes(name)) held |= 1 << index;
    }
    this.held = held;
  }

  /**
   * Run one instruction and advance the raster by what it cost.
   *
   * The interrupt is offered *before* the instruction rather than after, which is
   * the ordering every core in this project uses: a handler that runs one
   * instruction late would put the frame flag on the wrong side of a wait loop
   * about once in every few thousand frames.
   */
  stepInstruction(): number {
    if (this.vdp.vintPending && this.vdp.vintEnabled) {
      if (this.cpu.interrupt(6, VECTOR.vint)) this.vdp.vintPending = false;
    }
    const cycles = this.cpu.step();
    this.advance(cycles);
    // Unlike the Sega 8-bits, where the chip and the CPU share one clock, these
    // two are the master clock over fifteen and over seven — so a CPU cycle is
    // 7/15 of a chip clock and the remainder is carried rather than rounded.
    if (this.audioSink) {
      this.psgOwed += cycles * 7;
      const clocks = Math.floor(this.psgOwed / 15);
      this.psgOwed -= clocks * 15;
      if (clocks > 0) this.psg.run(clocks, this.audioSink);
    }
    // The FM chip shares the 68000's divider exactly, so this one has no
    // remainder to carry: one CPU cycle is one chip clock.
    if (this.ymSink) this.ym.run(cycles, this.ymSink);
    return cycles;
  }

  /** Advance the raster, raising the vertical interrupt when it reaches the edge. */
  private advance(cycles: number): void {
    this.cycles += cycles;
    while (this.cycles >= CYCLES_PER_LINE) {
      this.cycles -= CYCLES_PER_LINE;
      this.line += 1;
      if (this.line === FRAME_HEIGHT) {
        this.vdp.vblank = true;
        this.vdp.vintPending = true;
      }
      if (this.line >= LINES_PER_FRAME) {
        this.line = 0;
        this.vdp.vblank = false;
        this.frames += 1;
      }
      this.vdp.line = this.line;
    }
  }

  /** Run to the start of the next vertical blank; the speed measurement's clock. */
  runFrame(): number {
    const target = this.frames + 1;
    let cycles = 0;
    // Two frames' worth of instructions is a generous guard: a game that hangs
    // should stop the test rather than the process.
    for (let guard = 0; guard < 4_000_000 && this.frames < target; guard += 1) {
      cycles += this.stepInstruction();
    }
    return cycles;
  }

  /** Read a run of bytes out of the console's address space. */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.read8(address + index);
    return out;
  }
}
