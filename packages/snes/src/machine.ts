/**
 * The console around the processor: memory map, PPU, DMA, joypads.
 *
 * The Super Nintendo counterpart of `@demake/dmg`'s `Gameboy`, `@demake/nes`'s
 * `Nes` and `@demake/sms`'s `Sms`, and it exists for the same two jobs (doc 14
 * §Conformance, doc 07 §no CDN): boot a `demake build` cartridge in Vitest with
 * no toolchain and no emulator install, and play one in the page without
 * fetching a core from anywhere.
 *
 * Scope is set by what the generated runtime uses. **LoROM without a
 * coprocessor**, because that is the cartridge the backend builds and a mapper
 * nothing emits is a mapper nothing tests. Sound is a whole second computer
 * rather than a peripheral — `smp.ts` — and the four ports at `$2140`–`$2143` are
 * the only wire between them, which is why they are the only sound-related thing
 * in this file. They are decoded **before** the picture's registers, because they
 * sit inside that range: a bus that asks "is this a PPU register" first answers
 * every mailbox read with the PPU's, and a cartridge then spins for ever in the
 * boot handshake waiting for a greeting the sound side has already sent.
 *
 * Two things about the memory map are worth stating because they are what make
 * the backend's arrangement work:
 *
 *   - **The first 8 KiB of work RAM is visible in every low bank.** `$00:0000`
 *     through `$00:1FFF` *is* `$7E:0000` through `$7E:1FFF`, so a program whose
 *     whole state fits in eight kilobytes never touches the data bank register —
 *     which is why the backend's every address is a plain sixteen-bit absolute,
 *     and why the trace reader can read an entity record with one call.
 *   - **DMA takes its source bank as data.** That is what lets the tile bank live
 *     in bank one and reach video RAM without a single long addressing mode in the
 *     program.
 *
 * Sources: SNESdev Wiki — Memory map (https://snes.nesdev.org/wiki/Memory_map),
 * DMA (https://snes.nesdev.org/wiki/DMA) and Controller registers
 * (https://snes.nesdev.org/wiki/Controller_registers).
 */

import type { SampleSink } from "@demake/chip";

import { type Bus, Cpu } from "./cpu.js";
import { LINES_PER_FRAME, MASTER_PER_LINE, Ppu, SCREEN_HEIGHT, SCREEN_WIDTH } from "./ppu.js";
import { Smp } from "./smp.js";

export { SCREEN_HEIGHT, SCREEN_WIDTH };

/** Master cycles the CPU consumes per cycle at the console's usual speed. */
export const MASTER_PER_CPU = 6;

/** CPU cycles in one frame, near enough for a harness's frame budget. */
export const FRAME_CYCLES = (MASTER_PER_LINE * LINES_PER_FRAME) / MASTER_PER_CPU;

/**
 * Controller buttons, in the order the auto-read reports them.
 *
 * Bit 15 down to bit 4 of `$4218`, which is why `b` is first and the shoulder
 * buttons are last: the register is one sixteen-bit word and the pad's own order
 * is not the abstract one doc 14 §Buttons chose.
 */
export const BUTTONS = [
  "b",
  "y",
  "select",
  "start",
  "up",
  "down",
  "left",
  "right",
  "a",
  "x",
  "l",
  "r",
] as const;

/** One controller button. */
export type Button = (typeof BUTTONS)[number];

/** Bytes of a LoROM bank, which is what the CPU sees at `$8000`. */
const BANK_SIZE = 0x8000;

/** A Super Nintendo with a LoROM cartridge in it. */
export class Snes implements Bus {
  readonly cpu = new Cpu(this);
  readonly ppu = new Ppu();
  /** The sound side, with its own processor, its own RAM and its own program. */
  readonly smp = new Smp();
  /** The whole cartridge image. */
  readonly rom: Uint8Array;
  /** The console's 128 KiB of work RAM, of which bank zero sees the first 8. */
  readonly wram = new Uint8Array(0x20000);

  /** Frames whose vertical blank has begun — the harness's clock. */
  frames = 0;

  /** `$4200`: NMI enable in bit 7, auto joypad read in bit 0. */
  private nmitimen = 0;
  /** The NMI flag `$4210` reports and clears. */
  private nmiFlag = false;
  /** Whether an NMI is waiting to be taken. */
  private nmiPending = false;
  /** `$4016`/`$4017` and the auto-read's own copy of the pads. */
  private held = 0;
  private autoRead = 0;
  /** `$2181`–`$2183`: the work-RAM port's own address. */
  private wramAddr = 0;

  /** The eight DMA channels' registers, sixteen bytes each. */
  private readonly dma = new Uint8Array(8 * 16);

  /** Cycles the CPU owes for a transfer it just started. */
  private dmaCycles = 0;

  constructor(rom: Uint8Array) {
    if (rom.length < BANK_SIZE) throw new Error("snes: a cartridge is at least one 32 KiB bank");
    this.rom = rom;
    this.cpu.reset();
  }

  /** The picture, as RGBA. */
  get framebuffer(): Uint8ClampedArray {
    return this.ppu.framebuffer;
  }

  /**
   * Every S-DSP register write, for the conformance harness.
   *
   * The counterpart of `@demake/dmg`'s `apuTap` and `@demake/sms`'s `psgTap`, and
   * it observes rather than intercepts for the same reason: an oracle that
   * changed what the hardware saw would be testing itself.
   */
  get dspTap(): ((reg: number, value: number) => void) | undefined {
    return this.smp.dspTap;
  }
  set dspTap(tap: ((reg: number, value: number) => void) | undefined) {
    this.smp.dspTap = tap;
  }

  /** Where the sound side's output goes when anything is listening. */
  get audioSink(): SampleSink | undefined {
    return this.smp.audioSink;
  }
  set audioSink(sink: SampleSink | undefined) {
    this.smp.audioSink = sink;
  }

  // --- bus -------------------------------------------------------------------

  /**
   * Map a 24-bit address onto the cartridge, LoROM style.
   *
   * Bank `k` shows ROM offset `k × $8000` at `$8000`–`$FFFF`, and banks `$80`
   * upward mirror the ones below them. Anything past the end of the image wraps,
   * which is what a smaller cartridge in a bigger address space does.
   */
  private romByte(bank: number, offset: number): number {
    const at = ((bank & 0x7f) * BANK_SIZE + (offset - 0x8000)) % this.rom.length;
    return this.rom[at] as number;
  }

  read(address: number): number {
    const bank = (address >> 16) & 0xff;
    const offset = address & 0xffff;
    const low = bank & 0x7f;

    if (low <= 0x3f) {
      if (offset < 0x2000) return this.wram[offset] as number;
      // The sound processor's four ports, mirrored across the whole range, and
      // *before* the picture's registers because they sit inside that range: this
      // is the entire interface between the two computers, and a cartridge
      // uploads its driver through it at boot.
      if (offset >= 0x2140 && offset <= 0x217f) return this.smp.readPort(offset & 3);
      if (offset < 0x2200) return this.ppu.readRegister(0x2000 | offset);
      if (offset >= 0x2180 && offset <= 0x2183) {
        if (offset === 0x2180) {
          const byte = this.wram[this.wramAddr & 0x1ffff] as number;
          this.wramAddr = (this.wramAddr + 1) & 0x1ffff;
          return byte;
        }
        return 0;
      }
      if (offset >= 0x4200 && offset <= 0x421f) return this.readCpuRegister(offset);
      if (offset >= 0x4300 && offset <= 0x437f) return this.dma[offset - 0x4300] as number;
      if (offset >= 0x4016 && offset <= 0x4017) return 0;
      if (offset < 0x8000) return 0;
      return this.romByte(bank, offset);
    }
    if (low === 0x7e) return this.wram[offset] as number;
    if (low === 0x7f) return this.wram[0x10000 + offset] as number;
    return this.romByte(bank, offset < 0x8000 ? offset + 0x8000 : offset);
  }

  write(address: number, value: number): void {
    const bank = (address >> 16) & 0xff;
    const offset = address & 0xffff;
    const byte = value & 0xff;
    const low = bank & 0x7f;

    if (low === 0x7e) {
      this.wram[offset] = byte;
      return;
    }
    if (low === 0x7f) {
      this.wram[0x10000 + offset] = byte;
      return;
    }
    if (low > 0x3f) return; // the cartridge has nothing writable
    if (offset < 0x2000) {
      this.wram[offset] = byte;
      return;
    }
    if (offset >= 0x2140 && offset <= 0x217f) {
      this.smp.writePort(offset & 3, byte);
      return;
    }
    if (offset < 0x2200) {
      this.ppu.writeRegister(0x2000 | offset, byte);
      return;
    }
    if (offset >= 0x2180 && offset <= 0x2183) {
      if (offset === 0x2180) {
        this.wram[this.wramAddr & 0x1ffff] = byte;
        this.wramAddr = (this.wramAddr + 1) & 0x1ffff;
        return;
      }
      const shift = (offset - 0x2181) * 8;
      this.wramAddr = (this.wramAddr & ~(0xff << shift) & 0x1ffff) | ((byte << shift) & 0x1ffff);
      return;
    }
    if (offset >= 0x4200 && offset <= 0x421f) {
      this.writeCpuRegister(offset, byte);
      return;
    }
    if (offset >= 0x4300 && offset <= 0x437f) {
      this.dma[offset - 0x4300] = byte;
      return;
    }
  }

  // --- CPU-side registers ----------------------------------------------------

  private readCpuRegister(offset: number): number {
    switch (offset) {
      case 0x4210: {
        // Reading clears the flag, which is how a handler acknowledges the
        // interrupt. The low nibble is the CPU revision, which everything reports
        // as 2.
        const flag = this.nmiFlag ? 0x80 : 0x00;
        this.nmiFlag = false;
        return flag | 0x02;
      }
      case 0x4211:
        return 0;
      case 0x4212:
        // Vertical blank in bit 7, horizontal blank in bit 6, and the auto joypad
        // read's busy bit in bit 0 — which this model never reports as busy,
        // because the read happens the instant the blank begins.
        return (this.ppu.vblank ? 0x80 : 0x00) | (this.ppu.vblank ? 0x40 : 0x00);
      case 0x4218:
        return this.autoRead & 0xff;
      case 0x4219:
        return (this.autoRead >> 8) & 0xff;
      default:
        return 0;
    }
  }

  private writeCpuRegister(offset: number, byte: number): void {
    switch (offset) {
      case 0x4200:
        this.nmitimen = byte;
        return;
      case 0x420b:
        this.runDma(byte);
        return;
      default:
        return;
    }
  }

  // --- DMA -------------------------------------------------------------------

  /**
   * Run every channel `MDMAEN` names, lowest first.
   *
   * The five transfer modes the chip has, of which this runtime uses three: one
   * register (an object or colour upload), two registers (video RAM, whose two
   * data ports are consecutive), and the four-register mode nothing emits. A
   * transfer runs to completion here rather than being interleaved with the CPU,
   * which is what the real controller does too — it holds the bus.
   */
  private runDma(mask: number): void {
    for (let channel = 0; channel < 8; channel += 1) {
      if ((mask & (1 << channel)) === 0) continue;
      const base = channel * 16;
      const control = this.dma[base] as number;
      const destination = this.dma[base + 1] as number;
      let source =
        ((this.dma[base + 2] as number) | ((this.dma[base + 3] as number) << 8)) & 0xffff;
      const sourceBank = this.dma[base + 4] as number;
      let count = ((this.dma[base + 5] as number) | ((this.dma[base + 6] as number) << 8)) & 0xffff;
      if (count === 0) count = 0x10000;
      const toB = (control & 0x80) === 0;
      const fixed = (control & 0x08) !== 0;
      const step = (control & 0x10) !== 0 ? -1 : 1;
      const pattern = PATTERNS[control & 0x07] as readonly number[];

      for (let index = 0; index < count; index += 1) {
        const port = 0x2100 + ((destination + (pattern[index % pattern.length] as number)) & 0xff);
        const from = (sourceBank << 16) | source;
        if (toB) this.write(port, this.read(from));
        else this.write(from, this.read(port));
        if (!fixed) source = (source + step) & 0xffff;
      }
      // Eight master cycles a byte, which is what the controller costs the CPU.
      this.dmaCycles += Math.ceil((count * 8) / MASTER_PER_CPU) + 8;
      this.dma[base + 5] = 0;
      this.dma[base + 6] = 0;
      this.dma[base + 2] = source & 0xff;
      this.dma[base + 3] = (source >> 8) & 0xff;
    }
  }

  // --- controllers -----------------------------------------------------------

  /** Set which buttons are down. The auto-read latches them at each blank. */
  setButtons(down: Iterable<Button>): void {
    let mask = 0;
    for (const button of down) {
      const index = BUTTONS.indexOf(button);
      // Bit 15 is the first name in `BUTTONS`, so the shift counts downward.
      if (index >= 0) mask |= 1 << (15 - index);
    }
    this.held = mask;
  }

  // --- timing ----------------------------------------------------------------

  /** Run one instruction (or an interrupt dispatch) and clock the hardware. */
  stepInstruction(): number {
    if (this.nmiPending) {
      this.nmiPending = false;
      this.cpu.nmi();
    }
    let cycles = this.cpu.step();
    if (this.dmaCycles > 0) {
      cycles += this.dmaCycles;
      this.dmaCycles = 0;
    }
    const before = this.ppu.frames;
    const master = cycles * MASTER_PER_CPU;
    this.ppu.step(master);
    // The two processors share a crystal and nothing else, so the sound side is
    // paid in master cycles and converts them itself.
    this.smp.run(master);
    if (this.ppu.vblankStarted) {
      this.ppu.vblankStarted = false;
      this.nmiFlag = true;
      if ((this.nmitimen & 0x80) !== 0) this.nmiPending = true;
      // The pads are latched and shifted by the console itself once a frame, so
      // by the time a handler can read `$4218` the value is already there.
      if ((this.nmitimen & 0x01) !== 0) this.autoRead = this.held;
    }
    if (this.ppu.frames !== before) this.frames = this.ppu.frames;
    return cycles;
  }

  /** Run until the start of the next vertical blank, and return the frame index. */
  runFrame(): number {
    const target = this.frames + 1;
    let guard = 0;
    while (this.frames < target) {
      this.stepInstruction();
      // A runtime that hangs must fail the harness rather than the process.
      if ((guard += 1) > 4_000_000)
        throw new Error("snes: no vertical blank after 4M instructions");
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

/**
 * The B-bus offset pattern each transfer mode walks.
 *
 * Mode 1 is the one that makes a tilemap upload cheap: two consecutive registers
 * written alternately, which is exactly `VMDATAL`/`VMDATAH`.
 */
const PATTERNS: readonly (readonly number[])[] = [
  [0],
  [0, 1],
  [0, 0],
  [0, 0, 1, 1],
  [0, 1, 2, 3],
  [0, 1, 0, 1],
  [0, 0],
  [0, 0, 1, 1],
];
