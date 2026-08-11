/**
 * The console around the processor: memory map, PPU, APU, controllers, DMA.
 *
 * The NES counterpart of `@demake/dmg`'s `Gameboy`, and it exists for the same
 * two jobs (doc 14 §Conformance, doc 07 §no CDN): boot a `demake build`
 * cartridge in Vitest with no toolchain and no emulator install, and play one in
 * the page without fetching a core from anywhere.
 *
 * Scope is set by what the generated runtime uses. **Two mappers**, because the
 * backend builds two cartridges: NROM for a game that fits 32 KiB of program,
 * and **MMC1** for one that does not — sixteen kilobytes switched at `$8000`,
 * sixteen fixed at `$C000`, and the eight kilobytes of cartridge RAM at `$6000`
 * that are the only reason a game with four levels has anywhere to keep its
 * state (doc 13 §Banked cartridges). Which one a cartridge is comes out of its
 * own header and is never a setting, exactly as a Game Boy's controller does.
 * MMC1's one-screen mirroring modes are absent rather than half-implemented: no
 * cartridge this project builds selects one, and the other two are what the
 * renderer is written against. There is no PPU write-blocking outside VBlank for the reason the Game
 * Boy core gives about VRAM: the runtime is written to do its PPU work in the
 * VBlank window regardless, so modelling the block here would turn a discipline
 * failure into a mystery rather than catching it — the libretro E2E is where that
 * gets caught.
 *
 * The APU is not implemented here: it is `@demake/chip`'s `NesApu`, the same
 * model the audio pipeline renders previews with (doc 16 §Packages). This module
 * only routes `$4000`–`$4017` to it and offers the write tap the audio proof
 * reads.
 *
 * Sources: NESdev Wiki — CPU memory map (https://www.nesdev.org/wiki/CPU_memory_map),
 * Standard controller (https://www.nesdev.org/wiki/Standard_controller), and
 * DMA (https://www.nesdev.org/wiki/DMA).
 */

import { NesApu, type SampleSink } from "@demake/chip";

import { type Bus, Cpu } from "./cpu.js";
import {
  DOTS_PER_LINE,
  LINES_PER_FRAME,
  type Mirroring,
  Ppu,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from "./ppu.js";

export { SCREEN_HEIGHT, SCREEN_WIDTH };

/** CPU cycles in one frame: 341 dots × 262 lines, three dots to a cycle. */
export const FRAME_CYCLES = (DOTS_PER_LINE * LINES_PER_FRAME) / 3;

/**
 * Controller buttons, in the order the shift register reports them.
 *
 * `select` and `start` are real buttons here, unlike on the Master System — which
 * is what lets doc 14's abstract `start` map straight onto hardware.
 */
export const BUTTONS = ["a", "b", "select", "start", "up", "down", "left", "right"] as const;

/** One controller button. */
export type Button = (typeof BUTTONS)[number];

/** Where the header, the program and the characters sit in a `.nes` file. */
const HEADER_SIZE = 16;

/**
 * MMC1's control register at reset, and the bits that matter in it.
 *
 * The shift register resets to a sentinel whose walk out of the low end is what
 * counts the five writes, and the control register comes up with the PRG mode
 * that fixes the *last* bank at `$C000` — which is the arrangement every
 * cartridge here uses and the only one under which a reset vector read before a
 * single register has been written finds the code that was assembled for it.
 */
const MMC1_SHIFT_RESET = 0x10;
const MMC1_CONTROL_RESET = 0x0c;

/** Which sixteen-kilobyte half of the window the PRG bank register names. */
const MMC1_PRG_MODE = { switch32: 0, fixFirst: 2, fixLast: 3 } as const;

/** An NES with an NROM or MMC1 cartridge in it. */
export class Nes implements Bus {
  readonly cpu = new Cpu(this);
  readonly ppu: Ppu;
  /** The sound hardware — `@demake/chip`'s model, not a second one. */
  readonly apu = new NesApu();
  /** The whole `.nes` file, header included. */
  readonly rom: Uint8Array;
  /** The console's 2 KiB, which is the whole of a game's state. */
  readonly ram = new Uint8Array(0x0800);
  /** The cartridge's program, mapped at `$8000` and mirrored at `$C000`. */
  private readonly prg: Uint8Array;
  /** The mapper this cartridge declares: 0 for NROM, 1 for MMC1. */
  private readonly mapper: number;
  /**
   * The cartridge's own work RAM at `$6000`, on a board that carries some.
   *
   * Empty on NROM, which is why a demade game's whole state used to be the
   * console's two kilobytes. Not battery-backed: nothing this project builds
   * declares a save, so what a fresh machine reads here is zero.
   */
  private readonly prgRam: Uint8Array;
  /** MMC1's five-bit serial register, and the registers it feeds. */
  private mmcShift = MMC1_SHIFT_RESET;
  private control = MMC1_CONTROL_RESET;
  private prgBank = 0;
  /**
   * Whether the board is answering at `$6000` — MMC1's own switch for it.
   *
   * Bit 4 of the CHR bank 0 register on a board whose character memory is one
   * eight-kilobyte ROM, which is every cartridge this project builds: that line
   * has no bank to select, so it is wired to the RAM enable instead. The other
   * four bits of that register and the whole of CHR bank 1 select banks this
   * board does not have, so they are not stored — a field nothing can read back
   * is a field nobody is checking.
   */
  private prgRamEnabled = true;

  /** Frames completed since power-on — the harness's clock. */
  frames = 0;

  private held = 0;
  /** The controller's shift register, and the strobe that reloads it. */
  private shift = 0;
  private strobe = false;

  /**
   * Called for every write the CPU makes to a sound register.
   *
   * The audio conformance oracle's entire interface to the machine (doc 16 §The
   * proof, Level A). It observes rather than intercepts — the write still reaches
   * the APU — because an oracle that changed what the hardware saw would be
   * testing itself.
   */
  apuTap: ((reg: number, value: number) => void) | undefined = undefined;

  /**
   * Where the APU's samples go, when anything is listening.
   *
   * Left unset the chip still receives every write and keeps its state; it is
   * only *rendered* when a sink is attached, so the conformance suites pay
   * nothing for hardware they never listen to.
   */
  audioSink: SampleSink | undefined = undefined;

  constructor(rom: Uint8Array) {
    this.rom = rom;
    if (rom.length < HEADER_SIZE || rom[0] !== 0x4e || rom[1] !== 0x45) {
      throw new Error("nes: not an iNES file");
    }
    const prgBanks = rom[4] as number;
    const chrBanks = rom[5] as number;
    this.mapper = ((rom[6] as number) >> 4) | ((rom[7] as number) & 0xf0);
    if (this.mapper !== 0 && this.mapper !== 1) {
      throw new Error(`nes: only mappers 0 (NROM) and 1 (MMC1) are supported, not ${this.mapper}`);
    }
    // Bit 1 of flags 6 is the battery, and its presence is what a board with RAM
    // on it declares — but demake's cartridges declare RAM without a save, so the
    // mapper is what decides: MMC1 boards carry eight kilobytes and NROM none.
    this.prgRam = new Uint8Array(this.mapper === 1 ? 0x2000 : 0);
    const prgBytes = prgBanks * 0x4000;
    this.prg = rom.subarray(HEADER_SIZE, HEADER_SIZE + prgBytes);
    const chr = rom.subarray(HEADER_SIZE + prgBytes, HEADER_SIZE + prgBytes + chrBanks * 0x2000);
    const mirroring: Mirroring = ((rom[6] as number) & 1) !== 0 ? "vertical" : "horizontal";
    this.ppu = new Ppu(chr.length > 0 ? chr : new Uint8Array(0x2000), mirroring);
    this.cpu.reset();
  }

  /** The picture, as RGBA. */
  get framebuffer(): Uint8ClampedArray {
    return this.ppu.framebuffer;
  }

  // --- bus -------------------------------------------------------------------

  read(address: number): number {
    const at = address & 0xffff;
    if (at < 0x2000) return this.ram[at & 0x07ff] as number;
    if (at < 0x4000) return this.ppu.readRegister(at);
    if (at === 0x4016) return this.readController();
    if (at === 0x4017) return 0x40; // no second controller
    // `$4015` reports which length counters are still running. The chip model
    // exposes no reads, and a generated driver has no reason to ask — it knows
    // when a note ends because it wrote the schedule that ends it.
    if (at < 0x4018) return 0;
    if (at < 0x8000) {
      // Cartridge RAM, on a board that has some; open bus on one that does not.
      const answering = this.prgRam.length > 0 && this.prgRamEnabled;
      return answering ? (this.prgRam[at - 0x6000] as number) : 0;
    }
    if (this.mapper === 0) {
      // A 16 KiB program is mirrored into both halves of the window.
      return this.prg[(at - 0x8000) % this.prg.length] as number;
    }
    return this.prg[this.prgOffset(at)] as number;
  }

  /**
   * Which byte of the program a window address reaches, under MMC1.
   *
   * The control register's PRG mode decides whether the two halves of the window
   * are one thirty-two-kilobyte bank or a switched half and a fixed one — and
   * which half is fixed. A demade cartridge uses {@link MMC1_PRG_MODE.fixLast}
   * and only that, because the vectors are at the top of the image and a fixed
   * high half is what makes them reachable however the bank register is left.
   */
  private prgOffset(address: number): number {
    const banks = this.prg.length / 0x4000;
    const mode = (this.control >> 2) & 3;
    const high = address >= 0xc000;
    const offset = address & 0x3fff;
    if (mode === MMC1_PRG_MODE.fixLast) {
      const bank = high ? banks - 1 : this.prgBank & 0x0f;
      return (bank % banks) * 0x4000 + offset;
    }
    if (mode === MMC1_PRG_MODE.fixFirst) {
      const bank = high ? this.prgBank & 0x0f : 0;
      return (bank % banks) * 0x4000 + offset;
    }
    // Modes 0 and 1 are the same thing: the register's low bit is ignored and
    // both halves of the window come from one aligned pair.
    const pair = (this.prgBank & 0x0e) % banks;
    return pair * 0x4000 + (high ? 0x4000 : 0) + offset;
  }

  write(address: number, value: number): void {
    const at = address & 0xffff;
    const byte = value & 0xff;
    if (at < 0x2000) {
      this.ram[at & 0x07ff] = byte;
      return;
    }
    if (at < 0x4000) {
      this.ppu.writeRegister(at, byte);
      return;
    }
    if (at === 0x4014) {
      // Object DMA: 256 bytes from a page of CPU memory straight into OAM. The
      // real transfer stalls the CPU for 513 cycles, which the caller charges.
      const source = byte << 8;
      for (let index = 0; index < 0x100; index += 1) {
        this.ppu.oam[index] = this.read(source + index);
      }
      this.dmaCycles = 513;
      return;
    }
    if (at === 0x4016) {
      // Writing 1 then 0 latches the controller state into the shift register.
      const strobe = (byte & 1) !== 0;
      if (this.strobe && !strobe) this.shift = this.held;
      if (strobe) this.shift = this.held;
      this.strobe = strobe;
      return;
    }
    if (at < 0x4018) {
      this.apu.write(at - 0x4000, byte);
      this.apuTap?.(at - 0x4000, byte);
      return;
    }
    if (at < 0x8000) {
      if (this.prgRam.length > 0 && this.prgRamEnabled) this.prgRam[at - 0x6000] = byte;
      return;
    }
    if (this.mapper === 1) {
      this.writeMmc1(at, byte);
      return;
    }
    // An NROM cartridge has nothing writable; a store here is a no-op on hardware.
  }

  /**
   * MMC1's one register, written a bit at a time.
   *
   * Five writes to anywhere in `$8000`–`$FFFF` shift bit 0 in from the top, and
   * the **fifth** one lands the accumulated five bits in whichever of the four
   * registers the *last* address selects — so a driver builds the value with
   * `lsr` between stores and the destination is decided by where it stored, not
   * by what it stored. A write with bit 7 set abandons the sequence and forces
   * the PRG mode that fixes the last bank, which is what a reset does.
   *
   * The sentinel is what counts: the register starts at `$10` and every write
   * shifts right, so the bit that reaches the low end after five is the one this
   * began with. That is the hardware's own mechanism rather than a counter, and
   * it is why a sequence interrupted halfway leaves the register in a state no
   * caller can predict — which is the reason a demade cartridge never touches the
   * mapper from its NMI handler (doc 13 §Banked cartridges).
   */
  private writeMmc1(address: number, value: number): void {
    if ((value & 0x80) !== 0) {
      this.mmcShift = MMC1_SHIFT_RESET;
      this.control |= MMC1_CONTROL_RESET;
      return;
    }
    const complete = (this.mmcShift & 1) !== 0;
    this.mmcShift = ((this.mmcShift >> 1) | ((value & 1) << 4)) & 0x1f;
    if (!complete) return;
    const written = this.mmcShift;
    this.mmcShift = MMC1_SHIFT_RESET;
    if (address < 0xa000) {
      this.control = written;
      this.ppu.mirroring = (written & 3) === 2 ? "vertical" : "horizontal";
      if ((written & 3) < 2) {
        throw new Error("nes: MMC1 one-screen mirroring is not implemented");
      }
      return;
    }
    // The CHR registers select four-kilobyte banks of a character ROM this board
    // has exactly one of, so the only line that does anything is the RAM enable.
    if (address < 0xc000) this.prgRamEnabled = (written & 0x10) === 0;
    else if (address >= 0xe000) this.prgBank = written;
  }

  /** Cycles the CPU owes for a DMA it just started. */
  private dmaCycles = 0;

  // --- controllers -----------------------------------------------------------

  /** Set which buttons are down. Reads are of latched state, so this is state. */
  setButtons(down: Iterable<Button>): void {
    let mask = 0;
    for (const button of down) {
      const index = BUTTONS.indexOf(button);
      if (index >= 0) mask |= 1 << index;
    }
    this.held = mask;
  }

  /** One bit out of the shift register, low bit first, then ones forever. */
  private readController(): number {
    if (this.strobe) return 0x40 | (this.held & 1);
    const bit = this.shift & 1;
    this.shift = (this.shift >> 1) | 0x80;
    return 0x40 | bit;
  }

  // --- timing ----------------------------------------------------------------

  /** Run one instruction (or an interrupt dispatch) and clock the hardware. */
  stepInstruction(): number {
    if (this.ppu.nmi) {
      this.ppu.nmi = false;
      this.cpu.nmi();
    }
    let cycles = this.cpu.step();
    if (this.dmaCycles > 0) {
      cycles += this.dmaCycles;
      this.dmaCycles = 0;
    }
    const before = this.ppu.frames;
    this.ppu.step(cycles * 3);
    if (this.ppu.frames !== before) this.frames = this.ppu.frames;
    // The APU runs on the CPU's own clock, so one cycle is one APU clock and
    // there is no ratio to get wrong.
    if (this.audioSink) this.apu.run(cycles, this.audioSink);
    return cycles;
  }

  /** Run until the start of the next VBlank, and return the frame index. */
  runFrame(): number {
    const target = this.frames + 1;
    let guard = 0;
    while (this.frames < target) {
      this.stepInstruction();
      // A runtime that hangs must fail the harness rather than the process.
      if ((guard += 1) > 4_000_000) throw new Error("nes: no VBlank after 4M instructions");
    }
    return this.frames;
  }

  /** Read `length` bytes from an absolute address — the trace reader's window. */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.read(address + index);
    return out;
  }
}
