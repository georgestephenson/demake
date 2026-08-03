/**
 * The console around the processor: the mapper's banks, the video chips, the pad.
 *
 * The PC Engine counterpart of `@demake/nes`'s `Nes`, and it exists for the same
 * two jobs (doc 14 §Conformance, doc 07 §no CDN): boot a `demake build` cartridge
 * in Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * The bus here is *physical* — the CPU translates through its own `MPR` file
 * before anything reaches this class — so the map below is banks, not addresses,
 * and that is the whole shape of the machine:
 *
 * ```text
 *   $00-$7F   the HuCard, from its first byte
 *   $F7       battery-backed save RAM, which no demade game uses
 *   $F8       8 KiB of work RAM (the zero page and the stack are in it)
 *   $FF       the hardware page: VDC, VCE, PSG, timer, pad, interrupt control
 * ```
 *
 * Scope is set by what the generated runtime uses. **No mapper writes**: a HuCard
 * has no bank hardware of its own — the CPU's mapper is the only one there is —
 * so a cartridge bigger than the visible space is reached by `tam` and nothing
 * else, which is what the backend emits.
 *
 * The PSG is `@demake/chip`'s `Huc6280Psg`, not a second one — the same rule
 * every other core here keeps, and the reason `demake render` and a booted cartridge
 * cannot quietly stop agreeing. `psgTap` is the window doc 16's Level A proof
 * reads through, and `audioSink` is where the chip's output goes when something
 * wants to hear it.
 *
 * Sources: Archaic Pixels — PC Engine memory map, the I/O port and the interrupt
 * controller.
 */

import { Huc6280Psg, type SampleSink } from "@demake/chip";

import { type Bus, Cpu, HARDWARE_PAGE } from "./cpu.js";
import { LINES_PER_FRAME, MASTER_PER_LINE, SCREEN_HEIGHT, SCREEN_WIDTH, Vdc } from "./vdc.js";

export { SCREEN_HEIGHT, SCREEN_WIDTH };

/** Master clocks in one frame, which is what the harness's clock counts. */
export const FRAME_MASTER = MASTER_PER_LINE * LINES_PER_FRAME;

/**
 * Pad buttons, in the order the port reports them.
 *
 * Two nibbles rather than a shift register: the pad answers with directions or
 * with buttons depending on the select line, which is why `readPad` is a
 * multiplexer where the NES's is a queue.
 */
export const BUTTONS = ["up", "right", "down", "left", "i", "ii", "select", "run"] as const;

/** One pad button. */
export type Button = (typeof BUTTONS)[number];

/** Physical bank numbers this machine decodes. */
const RAM_BANK = 0xf8;
const SAVE_BANK = 0xf7;

/** A PC Engine with a HuCard in it. */
export class Pce implements Bus {
  readonly cpu = new Cpu(this);
  readonly vdc = new Vdc();
  /** The sound hardware — `@demake/chip`'s model, not a second one. */
  readonly psg = new Huc6280Psg();
  /** The cartridge image, from bank zero. */
  readonly rom: Uint8Array;
  /** The console's 8 KiB, which is where a game's whole state lives. */
  readonly ram = new Uint8Array(0x2000);
  /** Battery RAM, which nothing demade here uses but the map has to answer for. */
  readonly save = new Uint8Array(0x2000);

  /** Frames completed since power-on — the harness's clock. */
  frames = 0;

  /**
   * Called for every write the CPU makes to a sound register.
   *
   * The window doc 16's Level A proof reads. It *observes* rather than
   * intercepts: the chip receives the write either way, so an oracle watching
   * through it cannot change what the hardware saw.
   */
  psgTap: ((reg: number, value: number) => void) | undefined = undefined;

  /**
   * Where the chip's output goes, when anything wants it.
   *
   * Left unset the chip still receives every write and keeps its state; it is
   * only the integration that is skipped, which is what makes a conformance run
   * cost nothing for audio it does not listen to.
   */
  audioSink: SampleSink | undefined = undefined;

  private held = 0;
  /** The pad's two select lines: `SEL` chooses the nibble, `CLR` resets. */
  private select = false;
  private clear = false;

  /** The timer's reload, its counter and whether it is running (`$0C00`). */
  private timerReload = 0;
  private timerCounter = 0;
  private timerRunning = false;
  private timerCycles = 0;
  /** Latched until the program acknowledges it at `$1403`. */
  private timerFired = false;

  /** Master clocks not yet handed to the PSG, which runs at a sixth of them. */
  private psgClocks = 0;

  constructor(rom: Uint8Array) {
    if (rom.length === 0 || rom.length % 0x2000 !== 0) {
      throw new Error("pce: a HuCard image is a whole number of 8 KiB banks");
    }
    this.rom = rom;
    this.cpu.reset();
  }

  /** The picture, as RGBA. */
  get framebuffer(): Uint8ClampedArray {
    return this.vdc.framebuffer;
  }

  // --- bus -------------------------------------------------------------------

  read(address: number): number {
    const at = address & 0x1fffff;
    const bank = at >> 13;
    const offset = at & 0x1fff;
    if (bank < 0x80) {
      // A cartridge smaller than its address space mirrors, which is what the
      // hardware's unwired address lines do.
      return this.rom[at % this.rom.length] as number;
    }
    if (bank === RAM_BANK) return this.ram[offset] as number;
    if (bank === SAVE_BANK) return this.save[offset] as number;
    if (bank === 0xff) return this.readHardware(offset);
    // An unmapped bank floats; zero is as good an answer as any and is the one a
    // deterministic core has to give.
    return 0;
  }

  write(address: number, value: number): void {
    const at = address & 0x1fffff;
    const bank = at >> 13;
    const offset = at & 0x1fff;
    const byte = value & 0xff;
    if (bank === RAM_BANK) {
      this.ram[offset] = byte;
      return;
    }
    if (bank === SAVE_BANK) {
      this.save[offset] = byte;
      return;
    }
    if (bank === 0xff) {
      this.writeHardware(offset, byte);
      return;
    }
    // The cartridge is mask ROM; a store there is a no-op on hardware.
  }

  /** The `$FF` page: every peripheral this console has. */
  private readHardware(offset: number): number {
    if (offset < 0x0400) return this.vdc.readVdc(offset);
    if (offset < 0x0800) return this.vdc.readVce(offset);
    if (offset < 0x0c00) return 0; // the PSG is write-only
    if (offset < 0x1000) return this.readTimer(offset);
    if (offset < 0x1400) return this.readPad();
    if (offset < 0x1800) return this.readIrq(offset);
    return 0;
  }

  private writeHardware(offset: number, byte: number): void {
    if (offset < 0x0400) {
      this.vdc.writeVdc(offset, byte);
      return;
    }
    if (offset < 0x0800) {
      this.vdc.writeVce(offset, byte);
      return;
    }
    if (offset < 0x0c00) {
      // The ten registers are mirrored through the whole kilobyte, which is what
      // the mask is: the chip decodes four address lines and no more.
      const reg = offset & 0x0f;
      this.psg.write(reg, byte);
      this.psgTap?.(reg, byte);
      return;
    }
    if (offset < 0x1000) {
      this.writeTimer(offset, byte);
      return;
    }
    if (offset < 0x1400) {
      // The pad's two control lines, and nothing else on this address.
      this.select = (byte & 0x01) !== 0;
      const clear = (byte & 0x02) !== 0;
      this.clear = clear;
      return;
    }
    if (offset < 0x1800) {
      this.writeIrq(offset, byte);
      return;
    }
  }

  // --- the pad ---------------------------------------------------------------

  /** Set which buttons are down. The port is a multiplexer, so this is state. */
  setButtons(down: Iterable<Button>): void {
    let mask = 0;
    for (const button of down) {
      const index = BUTTONS.indexOf(button);
      if (index >= 0) mask |= 1 << index;
    }
    this.held = mask;
  }

  /**
   * One nibble of the pad, chosen by `SEL`, active low.
   *
   * `CLR` high reports nothing at all, which is how a program tells a pad from a
   * multitap. The top nibble carries the region — zero for Japan, which is what
   * every emulator expects of a HuCard.
   */
  private readPad(): number {
    if (this.clear) return 0x30;
    const nibble = this.select ? (this.held >> 4) & 0x0f : this.held & 0x0f;
    return 0x30 | (~nibble & 0x0f);
  }

  // --- the timer -------------------------------------------------------------

  private readTimer(offset: number): number {
    return (offset & 1) === 0 ? this.timerCounter & 0x7f : 0;
  }

  private writeTimer(offset: number, byte: number): void {
    if ((offset & 1) === 0) {
      this.timerReload = byte & 0x7f;
      return;
    }
    const running = (byte & 1) !== 0;
    // Starting a stopped timer reloads it; a write while it runs does not, which
    // is the difference between a periodic tick and one that jitters.
    if (running && !this.timerRunning) {
      this.timerCounter = this.timerReload;
      this.timerCycles = 0;
    }
    this.timerRunning = running;
  }

  /** Advance the timer by `cycles` CPU clocks, at its own 1/1024 divider. */
  private stepTimer(cycles: number): void {
    if (!this.timerRunning) return;
    this.timerCycles += cycles;
    while (this.timerCycles >= 1024) {
      this.timerCycles -= 1024;
      if (this.timerCounter === 0) {
        this.timerCounter = this.timerReload;
        this.timerFired = true;
      } else {
        this.timerCounter -= 1;
      }
    }
    this.cpu.setIrq("timer", this.timerFired);
  }

  // --- the interrupt controller ----------------------------------------------

  private readIrq(offset: number): number {
    if ((offset & 3) === 2) return this.cpu.irqMask & 7;
    if ((offset & 3) === 3) {
      // Reading the status also acknowledges the timer, which is the only source
      // that has no register of its own to clear.
      const value = (this.timerFired ? 0x04 : 0) | (this.vdc.irq ? 0x02 : 0);
      return value;
    }
    return 0;
  }

  private writeIrq(offset: number, byte: number): void {
    if ((offset & 3) === 2) {
      this.cpu.irqMask = byte & 7;
      return;
    }
    if ((offset & 3) === 3) {
      // Any write acknowledges the timer.
      this.timerFired = false;
      this.cpu.setIrq("timer", false);
    }
  }

  // --- timing ----------------------------------------------------------------

  /** Run one instruction (or an interrupt dispatch) and clock the hardware. */
  stepInstruction(): number {
    const cycles = this.cpu.step();
    // Three master clocks a cycle at 7.16 MHz, twelve at 1.79 — which is a `csh`
    // the boot code performs and never undoes, but the model has to answer for
    // both or a cartridge that forgot it would run four times too fast here and
    // correctly on hardware.
    const master = cycles * (this.cpu.fast ? 3 : 12);
    this.vdc.step(master);
    this.cpu.setIrq("irq1", this.vdc.irq);
    this.stepTimer(cycles);
    // The PSG is fed the master clock divided by six, so its clock is a ratio of
    // the CPU's rather than the same number — which is why this counts master
    // clocks and the timer above counts the processor's own.
    if (this.audioSink) {
      this.psgClocks += master;
      const steps = (this.psgClocks / 6) | 0;
      if (steps > 0) {
        this.psgClocks -= steps * 6;
        this.psg.run(steps, this.audioSink);
      }
    }
    this.frames = this.vdc.frames;
    return cycles;
  }

  /** Run until the next frame boundary, and return the frame index. */
  runFrame(): number {
    const target = this.frames + 1;
    let guard = 0;
    while (this.frames < target) {
      this.stepInstruction();
      // A runtime that hangs must fail the harness rather than the process.
      if ((guard += 1) > 4_000_000) throw new Error("pce: no frame after 4M instructions");
    }
    return this.frames;
  }

  /**
   * Read `length` bytes of work RAM — the trace reader's window.
   *
   * Work RAM rather than the address space, and the difference matters on this
   * console alone. A game's state is in the 8 KiB of bank `$F8`, and the memory
   * plan addresses it from `$2000` because that is the page a program's own `tam`
   * maps it into (`codegen/layout.ts` §`PCE_MEMORY`) — but *until* that `tam`
   * runs, logical `$2000` is cartridge, so a reader that went through the mapper
   * would report a game's score as whatever byte of the boot stub happens to sit
   * there. Masking to the bank is what makes the window mean the same thing
   * before and after boot, which is what a harness watching for the runtime to
   * finish initialising needs.
   */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      out[index] = this.ram[(address + index) & 0x1fff] as number;
    }
    return out;
  }
}

/** The physical base of the hardware page, for a harness that wants to poke it. */
export { HARDWARE_PAGE };
