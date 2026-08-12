/**
 * The Virtual Boy around its processor: memory, the cartridge, the pads, and the
 * one interrupt a demade cartridge takes.
 *
 * Three things about this machine decide the shape of this file.
 *
 *   - **There is no boot ROM to model.** The processor fetches its first
 *     instruction from `$FFFFFFF0`, which — because the address bus is 27 bits —
 *     *is* the top of the cartridge region whatever size the board is. So
 *     "booting" here is pointing the program counter at that address and letting
 *     the cartridge's own reset stub run, which is the shortest hand-off of any
 *     console in this project.
 *   - **A vector is code, not a pointer.** The interrupt lands *at*
 *     `$FFFFFE40`, in the cartridge, so this machine performs the hardware's own
 *     save-and-jump and the cartridge supplies whatever is there — the Neo Geo
 *     Pocket's pointer-in-RAM arrangement inverted.
 *   - **The picture is drawn between frames, not during them.** The drawing
 *     processor fills the framebuffer pair the display is *not* showing, so a
 *     runtime writes worlds and objects whenever it likes and the swap is what
 *     makes them visible. That is why {@link Vb.runFrame} draws once and then
 *     raises, rather than modelling a beam.
 *
 * The **sound is `@demake/chip`'s VSU**, not a second copy and not a register
 * page that swallows writes: six channels, five of them wavetables, advanced by
 * the same master clock the processor counts (twenty megahertz over four).
 * `vsuTap` is the window doc 16's Level A proof reads through, and it *observes*
 * rather than intercepts — a ROM that had to be instrumented to be testable
 * would not be the ROM that ships.
 *
 * Two things about that wiring are this console's. **Nothing on the chip reads
 * back**, so the register page answers zero rather than the byte last written:
 * keeping a shadow to read would be a second model of the chip, and the one
 * thing worse than an absent peripheral is a peripheral that agrees with itself.
 * And **the chip is advanced only when something is listening**, which is safe
 * here for the reason it is not on a Mega Drive: there is no status byte and no
 * timer, so a cartridge cannot tell whether it ran.
 *
 * What is **absent rather than half-implemented**: the hardware timer, the link
 * port, and cartridge RAM beyond a plain array. Each is a gap rather than a
 * decision.
 */

import { Vsu, VSU_CLOCK_HZ, type SampleSink } from "@demake/chip";

import {
  VB_INTCLR,
  VB_INTENB,
  VB_INTPND,
  VB_INT_FRAMESTART,
  VB_INT_GAMESTART,
  VB_INT_XPEND,
  VB_KEY_A,
  VB_KEY_B,
  VB_KEY_LD,
  VB_KEY_LL,
  VB_KEY_LR,
  VB_KEY_LU,
  VB_KEY_SGN,
  VB_KEY_STA,
  VB_SCR,
  VB_SCR_HW_READ,
  VB_SCR_STAT,
  VB_SDHR,
  VB_SDLR,
  VB_VECTOR_RESET,
  VB_VECTOR_VIP,
  VB_WRAM_SIZE,
} from "@demake/core";

import { V810, type Bus } from "./cpu.js";
import { Vip, type Eye } from "./vip.js";

/** The processor's clock, in hertz. */
export const MASTER_HZ = 20_000_000;

/** Display frames a second, which is also game frames when `FRMCYC` is zero. */
export const FRAME_HZ = 50.2;

/** Processor cycles in one frame. */
export const CYCLES_PER_FRAME = Math.round(MASTER_HZ / FRAME_HZ);

/**
 * Master cycles per sound-processor clock.
 *
 * Four, and it divides exactly: `VSU_CLOCK_HZ` is five megahertz against this
 * machine's twenty, so nothing about the audio rounds. Derived rather than
 * written down, so a change to either number is caught here.
 */
const VSU_DIVIDER = MASTER_HZ / VSU_CLOCK_HZ;

/** The exception code the video processor's interrupt carries. */
const INT_VIP_CODE = 0xfe40;

/** Bytes of cartridge RAM a board may carry. */
const SRAM_SIZE = 0x2000;

/**
 * Keys, as the language names them.
 *
 * Seven, which is doc 14's portable floor. This console has two D-pads and this
 * is the left one, because that is the one a game's movement is written for; the
 * right pad is a second axis the language has no vocabulary for.
 */
export const BUTTONS = ["left", "right", "up", "down", "a", "b", "start"] as const;

/** One key. */
export type Button = (typeof BUTTONS)[number];

const KEY_MASK: Readonly<Record<Button, number>> = {
  left: VB_KEY_LL,
  right: VB_KEY_LR,
  up: VB_KEY_LU,
  down: VB_KEY_LD,
  a: VB_KEY_A,
  b: VB_KEY_B,
  start: VB_KEY_STA,
};

export class Vb implements Bus {
  /** Sixty-four kilobytes at `$05000000`, and all a game gets. */
  readonly wram = new Uint8Array(VB_WRAM_SIZE);

  /** Cartridge RAM, which a demade board does not use. */
  readonly sram = new Uint8Array(SRAM_SIZE);

  /**
   * The sound processor — `@demake/chip`'s model, not a second one.
   *
   * The same object the schedule was fitted against, which is what makes doc
   * 16's Level A a comparison between a schedule and a cartridge rather than
   * between two copies of one piece of code.
   */
  readonly vsu = new Vsu();

  /**
   * Every write the chip receives, observed rather than intercepted.
   *
   * `reg` is the **byte offset from the chip's base**, which is what a schedule's
   * register number is on this console: the waveform tables, the modulation table
   * and the six channel blocks are one address space rather than a port and an
   * index (`@demake/chip`'s `Vsu.write`).
   */
  vsuTap: ((reg: number, value: number) => void) | undefined = undefined;

  /**
   * Where the chip's samples go, if anywhere.
   *
   * Absent by default, and the chip is not advanced without it — a demade
   * cartridge cannot observe this hardware by any other route, so a machine
   * nobody is listening to should cost nothing for audio.
   */
  audioSink: SampleSink | undefined = undefined;

  /** The video processor: memory, registers and both eyes. */
  readonly vip = new Vip();

  readonly cpu = new V810(this);

  /** The cartridge, as it answers from `$07000000` and every mirror above it. */
  rom: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  /** Frames completed since the machine was loaded. */
  frames = 0;

  /** Cycles owed to the next frame boundary. */
  private cycles = 0;

  /** Master cycles the sound processor has not been charged for yet. */
  private vsuCycles = 0;

  /** Which keys are down, as the pad word a cartridge will read. */
  private held = VB_KEY_SGN;

  /** The pad word the last hardware read latched. */
  private latched = VB_KEY_SGN;

  private scr = 0;

  constructor(rom?: Uint8Array) {
    if (rom) this.load(rom);
  }

  /** The left eye's picture, as RGBA — the one a mono harness looks at. */
  get framebuffer(): Uint8ClampedArray {
    return this.vip.render("left");
  }

  /** Either eye's picture, as RGBA. */
  eye(which: Eye): Uint8ClampedArray {
    return this.vip.render(which);
  }

  /**
   * Load a cartridge and start the processor where the hardware does.
   *
   * There is no header to read and no entry field to chase: `$FFFFFFF0` is the
   * top of the cartridge, the reset stub is there, and it jumps wherever the
   * program actually starts.
   */
  load(rom: Uint8Array): void {
    if ((rom.length & (rom.length - 1)) !== 0) {
      throw new Error(`vb: a cartridge is a power of two bytes, not ${rom.length}`);
    }
    this.rom = rom;
    this.wram.fill(0);
    this.sram.fill(0);
    this.vip.reset();
    this.frames = 0;
    this.cycles = 0;
    this.cpu.reset(VB_VECTOR_RESET);
  }

  // --- the bus ---------------------------------------------------------------

  read(address: number): number {
    const at = address >>> 0;
    switch ((at >>> 24) & 7) {
      case 0:
        return this.vip.read(at);
      case 1:
        // Nothing on this chip reads back, so there is nothing to answer with.
        return 0;
      case 2:
        return this.hardware(at);
      case 5:
        return this.wram[at & (VB_WRAM_SIZE - 1)] as number;
      case 6:
        return this.sram[at & (SRAM_SIZE - 1)] as number;
      case 7:
        return this.rom.length === 0 ? 0xff : (this.rom[at & (this.rom.length - 1)] as number);
      default:
        return 0;
    }
  }

  write(address: number, value: number): void {
    const at = address >>> 0;
    const byte = value & 0xff;
    switch ((at >>> 24) & 7) {
      case 0: {
        this.vip.write(at, byte);
        // Acknowledging is a write of the bits to clear, not a store.
        if ((at & 0x7fffe) === (VB_INTCLR & 0x7fffe)) {
          const clear = this.vip.reg(VB_INTCLR);
          this.vip.setReg(VB_INTPND, this.vip.reg(VB_INTPND) & ~clear);
        }
        return;
      }
      case 1:
        this.vsu.write(at & 0x7ff, byte);
        this.vsuTap?.(at & 0x7ff, byte);
        return;
      case 2:
        this.setHardware(at, byte);
        return;
      case 5:
        this.wram[at & (VB_WRAM_SIZE - 1)] = byte;
        return;
      case 6:
        this.sram[at & (SRAM_SIZE - 1)] = byte;
        return;
      default:
        return;
    }
  }

  private hardware(at: number): number {
    switch (at & 0xfffffffc) {
      case VB_SDLR:
        return this.latched & 0xff;
      case VB_SDHR:
        return (this.latched >> 8) & 0xff;
      case VB_SCR:
        return this.scr;
      default:
        return 0;
    }
  }

  /**
   * A pad read is a request, and it completes at once here.
   *
   * On the hardware the controller is a shift register and the read takes a few
   * hundred microseconds, with `STAT` set while it runs. Nothing a demade
   * cartridge does can observe the difference — it asks, then polls until `STAT`
   * clears — so this latches immediately and clears the bit, which is a read
   * that has already finished rather than one that never happens.
   */
  private setHardware(at: number, value: number): void {
    if ((at & 0xfffffffc) !== VB_SCR) return;
    this.scr = value & ~(VB_SCR_STAT | VB_SCR_HW_READ);
    if ((value & VB_SCR_HW_READ) !== 0) this.latched = this.held;
  }

  // --- running ---------------------------------------------------------------

  /**
   * Run one instruction and return what it cost.
   *
   * **The frame happens here rather than in {@link runFrame}**, and that is the
   * whole reason this is not two methods with the display work in the outer one:
   * a cartridge that waits for a frame by *polling* — which this console's
   * demade games do, because they take no interrupt anywhere — never returns to
   * a caller stepping instructions, so a harness driving the machine one
   * instruction at a time would spin for ever on a flag only the other method
   * could set.
   */
  step(): number {
    const cycles = this.cpu.step();
    // The sound processor runs off the same crystal the processor counts, at a
    // quarter of it — twenty megahertz over four is the five the chip model
    // states — so a whole number of chip clocks comes out of every instruction
    // and the remainder is carried rather than dropped.
    if (this.audioSink) {
      this.vsuCycles += cycles;
      const clocks = (this.vsuCycles / VSU_DIVIDER) | 0;
      if (clocks > 0) {
        this.vsuCycles -= clocks * VSU_DIVIDER;
        this.vsu.run(clocks, this.audioSink);
      }
    }
    this.cycles += cycles;
    if (this.cycles >= CYCLES_PER_FRAME) {
      this.cycles -= CYCLES_PER_FRAME;
      this.endFrame();
    }
    return cycles;
  }

  /**
   * Draw the frame and raise what it raises.
   *
   * The drawing processor fills the pair the display is not showing and then the
   * interrupt is raised — in that order, because a runtime's handler counts the
   * frame and the main loop writes the *next* one's worlds, and a picture drawn
   * after the handler ran would be a frame behind everything else.
   */
  private endFrame(): void {
    this.frames += 1;
    this.vip.drawFrame();
    const pending = this.vip.reg(VB_INTPND) | VB_INT_GAMESTART | VB_INT_FRAMESTART | VB_INT_XPEND;
    this.vip.setReg(VB_INTPND, pending);
    if ((pending & this.vip.reg(VB_INTENB)) !== 0) {
      this.cpu.interrupt(INT_VIP_CODE, VB_VECTOR_VIP);
    }
  }

  /** Run until the next frame boundary. */
  runFrame(limit = 8_000_000): number {
    const target = this.frames + 1;
    let guard = 0;
    while (this.frames < target) {
      this.step();
      if ((guard += 1) > limit) throw new Error("vb: no frame after 8M instructions");
    }
    return this.frames;
  }

  /** Set which keys are down. */
  setButtons(down: Iterable<Button>): void {
    let mask = VB_KEY_SGN;
    for (const button of down) {
      const bit = KEY_MASK[button as Button];
      if (bit !== undefined) mask |= bit;
    }
    this.held = mask;
    // A harness that sets the keys and immediately reads a frame should not have
    // to wait for the cartridge's next poll to see them.
    this.latched = mask;
  }

  /**
   * Read `length` bytes of the machine's address space — the trace reader's
   * window.
   *
   * Through the bus rather than out of the work RAM array, because a caller may
   * legitimately want the cartridge or the video processor's own memory, and
   * neither is an array this class owns.
   */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.read((address + index) >>> 0);
    return out;
  }
}

/** Where the pad word says the hardware itself is, rather than a button. */
export const PAD_ALWAYS_SET = VB_KEY_SGN;
