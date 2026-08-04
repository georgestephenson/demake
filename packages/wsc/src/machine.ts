/**
 * The console around the processor: 64 KiB of RAM, a banked cartridge, the keys.
 *
 * The WonderSwan Color counterpart of `@demake/pce`'s `Pce`, and it exists for
 * the two jobs every owned core here does (doc 14 §Conformance, doc 07 §no CDN):
 * boot a `demake build` cartridge in Vitest with no toolchain and no emulator
 * install, and play one in the page without fetching a core from anywhere.
 *
 * The address space is twenty bits, sixteen segments of 64 KiB, and only two
 * kinds of thing are in it:
 *
 * ```text
 *   segment $0        the console's own 64 KiB — work RAM *and* everything the
 *                     display reads: two screen maps, the tile bank, the object
 *                     table and palette RAM
 *   segment $1        battery-backed save RAM, which no demade game uses
 *   segments $2, $3   two cartridge banks, selected by ports $C2 and $C3
 *   segments $4–$F    the linear cartridge window, whose high bits are port $C0
 * ```
 *
 * The banking registers come up all-ones, so segment `$F` reaches the top 64 KiB
 * of the cartridge from reset — which is where the program is and why a demade
 * cartridge never writes one of those ports.
 *
 * **There are no interrupts here, and that is the cartridge's decision rather
 * than a gap.** This console's interrupt controller vectors through the
 * processor's own table in the first kilobyte of RAM, and a demade game has no
 * use for it: its main loop waits on the display's line counter, exactly as the
 * Nintendo DS's does, because a loop that waits is a loop that waits either way.
 * The controller's ports are accepted and inert; the day this console gains an
 * audio driver is the day that stops being enough, and it will be a change here
 * rather than a different shape of core.
 *
 * The sound hardware is **absent rather than half-implemented**, on the same
 * terms as `@demake/md`'s FM half: `demake build -c wsc` emits no audio driver,
 * so a model of the chip would be a model nobody is checking. Its ports read as
 * zero and store as bytes.
 *
 * Sources: WSdev wiki — Memory map, I/O ports, Cartridge banking and Keypad.
 */

import { Cpu, type Bus } from "./cpu.js";
import { Display, LINES_PER_FRAME, SCREEN_HEIGHT, SCREEN_WIDTH } from "./display.js";

export { SCREEN_HEIGHT, SCREEN_WIDTH };

/** Processor cycles in one frame, which is what the harness's clock counts. */
export const FRAME_CYCLES = 256 * LINES_PER_FRAME;

/** The processor's clock, in hertz — a frame is 75.47 of these. */
export const CPU_HZ = 3_072_000;

/**
 * Keys, as the language names them.
 *
 * In landscape the X cluster is the direction pad, which is why "up" is a key on
 * a console whose hardware calls it `X1`.
 */
export const BUTTONS = ["up", "right", "down", "left", "a", "b", "start"] as const;

/** One key. */
export type Button = (typeof BUTTONS)[number];

/** The keypad port, and the three groups it multiplexes. */
const KEYPAD = 0xb5;
const GROUP_X = 0x20;
const GROUP_BUTTONS = 0x40;

/** Cartridge banking. */
const BANK_LINEAR = 0xc0;
const BANK_SRAM = 0xc1;
const BANK_ROM0 = 0xc2;
const BANK_ROM1 = 0xc3;

/** A WonderSwan Color with a cartridge in it. */
export class Wsc implements Bus {
  readonly cpu = new Cpu(this);
  /** The console's 64 KiB: a game's state and everything the display reads. */
  readonly ram = new Uint8Array(0x10000);
  readonly display = new Display(this.ram);
  /** The cartridge image, from its first byte. */
  readonly rom: Uint8Array;
  /** Battery RAM, which nothing demade here uses but the map has to answer for. */
  readonly save = new Uint8Array(0x10000);

  /** Ports nothing in this model interprets, kept so a read-back is honest. */
  private readonly ports = new Uint8Array(0x100);

  private held = 0;
  private keyGroup = 0;

  constructor(rom: Uint8Array) {
    if (rom.length < 0x10000 || (rom.length & (rom.length - 1)) !== 0) {
      throw new Error("wsc: a cartridge is a power of two and at least 64 KiB");
    }
    this.rom = rom;
    this.ports[BANK_LINEAR] = 0xff;
    this.ports[BANK_SRAM] = 0xff;
    this.ports[BANK_ROM0] = 0xff;
    this.ports[BANK_ROM1] = 0xff;
    this.cpu.reset();
  }

  /** Frames completed since power-on. */
  get frames(): number {
    return this.display.frames;
  }

  /** The picture, as RGBA. */
  get framebuffer(): Uint8ClampedArray {
    return this.display.framebuffer;
  }

  // --- the address space -----------------------------------------------------

  /** Where a cartridge segment lands in the image, which is always in range. */
  private romAddress(segment: number, offset: number): number {
    const bank =
      segment === 2
        ? (this.ports[BANK_ROM0] as number)
        : segment === 3
          ? (this.ports[BANK_ROM1] as number)
          : ((this.ports[BANK_LINEAR] as number) << 4) | segment;
    // A cartridge smaller than the address the banking names mirrors, which is
    // what the unwired address lines of a smaller mask ROM do — and is why
    // segment $F reaches the last bank of any size of cartridge.
    return ((bank << 16) | offset) & (this.rom.length - 1);
  }

  read(address: number): number {
    const at = address & 0xfffff;
    const segment = at >> 16;
    const offset = at & 0xffff;
    if (segment === 0) return this.ram[offset] as number;
    if (segment === 1) return this.save[offset] as number;
    return this.rom[this.romAddress(segment, offset)] as number;
  }

  write(address: number, value: number): void {
    const at = address & 0xfffff;
    const segment = at >> 16;
    const offset = at & 0xffff;
    if (segment === 0) {
      this.ram[offset] = value & 0xff;
      return;
    }
    if (segment === 1) {
      this.save[offset] = value & 0xff;
      return;
    }
    // The cartridge is mask ROM; a store there is a no-op on hardware.
  }

  // --- ports -----------------------------------------------------------------

  readPort(port: number): number {
    const at = port & 0xff;
    if (Display.owns(at)) return this.display.read(at);
    if (at === KEYPAD) return this.readKeypad();
    return this.ports[at] as number;
  }

  writePort(port: number, value: number): void {
    const at = port & 0xff;
    const byte = value & 0xff;
    this.ports[at] = byte;
    if (Display.owns(at)) {
      this.display.write(at, byte);
      return;
    }
    if (at === KEYPAD) this.keyGroup = byte & 0x70;
  }

  // --- the keypad ------------------------------------------------------------

  /** Set which keys are down. The port is a multiplexer, so this is state. */
  setButtons(down: Iterable<Button>): void {
    let mask = 0;
    for (const button of down) {
      const index = BUTTONS.indexOf(button as Button);
      if (index >= 0) mask |= 1 << index;
    }
    this.held = mask;
  }

  /**
   * The selected group of keys, active *high*.
   *
   * Unlike every other console in this set, a pressed key reads as a one here —
   * so a runtime that inverted it out of habit would have every direction held
   * from power-on.
   */
  private readKeypad(): number {
    let bits = 0;
    if ((this.keyGroup & GROUP_X) !== 0) bits |= this.held & 0x0f;
    if ((this.keyGroup & GROUP_BUTTONS) !== 0) {
      if ((this.held & 0x40) !== 0) bits |= 0x01; // start
      if ((this.held & 0x10) !== 0) bits |= 0x02; // a
      if ((this.held & 0x20) !== 0) bits |= 0x04; // b
    }
    // The Y cluster ($10) reports nothing: a demade game binds the X pad, and a
    // group with no keys behind it answering zero is what the hardware does.
    return this.keyGroup | bits;
  }

  // --- timing ----------------------------------------------------------------

  /** Run one instruction and clock the display with what it cost. */
  stepInstruction(): number {
    const cycles = this.cpu.step();
    this.display.step(cycles);
    return cycles;
  }

  /** Run until the next frame boundary, and return the frame index. */
  runFrame(): number {
    const target = this.frames + 1;
    let guard = 0;
    while (this.frames < target) {
      this.stepInstruction();
      // A runtime that hangs must fail the harness rather than the process.
      if ((guard += 1) > 4_000_000) throw new Error("wsc: no frame after 4M instructions");
    }
    return this.frames;
  }

  /**
   * Read `length` bytes of the console's RAM — the trace reader's window.
   *
   * A plain read of segment zero, because on this console that is where
   * everything is: a game's state, and the picture the display is drawing out of
   * the same sixty-four kilobytes.
   */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      out[index] = this.ram[(address + index) & 0xffff] as number;
    }
    return out;
  }
}
