/**
 * The console around the processor: memory map, PPU, APU, controllers, DMA.
 *
 * The NES counterpart of `@demake/dmg`'s `Gameboy`, and it exists for the same
 * two jobs (doc 14 §Conformance, doc 07 §no CDN): boot a `demake build`
 * cartridge in Vitest with no toolchain and no emulator install, and play one in
 * the page without fetching a core from anywhere.
 *
 * Scope is set by what the generated runtime uses. **NROM only**: 32 KiB of
 * program at `$8000` and 8 KiB of character ROM, because that is the cartridge
 * the backend builds and a mapper nothing emits is a mapper that cannot be
 * tested. There is no PPU write-blocking outside VBlank for the reason the Game
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

/** An NES with an NROM cartridge in it. */
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
    if ((rom[6] as number) >> 4 !== 0 || (rom[7] as number) >> 4 !== 0) {
      throw new Error("nes: only mapper 0 (NROM) is supported");
    }
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
    if (at < 0x8000) return 0; // no cartridge RAM on NROM
    // A 16 KiB program is mirrored into both halves of the window.
    return this.prg[(at - 0x8000) % this.prg.length] as number;
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
    // The cartridge has nothing writable; a store here is a no-op on hardware.
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
