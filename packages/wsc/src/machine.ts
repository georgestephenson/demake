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

import { WsSound, WS_SOUND_PORT_FIRST, WS_SOUND_PORT_LAST, type SampleSink } from "@demake/chip";

import { Cpu, type Bus } from "./cpu.js";
import {
  CYCLES_PER_LINE,
  Display,
  LINES_PER_FRAME,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  VBLANK_LINE,
} from "./display.js";

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

/**
 * The two timers, whose counters are readable.
 *
 * The horizontal one decrements every 256 CPU cycles — one scanline — and the
 * vertical one at the start of line 144, so between them they are a scanline
 * clock and a frame clock. What a demade cartridge uses is the *vertical* one,
 * and it uses it as a **tally rather than a source of interrupts**: with the
 * repeat bit set the counter runs down and reloads for ever, so how many frames
 * have passed is a subtraction the driver performs rather than a flag it has to
 * catch (doc 16 §A frame-clocked console counts frames). That is the Nintendo
 * DS's argument reached by different hardware, and it is why this console needs
 * no interrupt controller to keep tempo.
 */
const TIMER_CONTROL = 0xa2;
const TIMER_H_RELOAD = 0xa4;
const TIMER_V_RELOAD = 0xa6;
const TIMER_H_COUNT = 0xa8;
const TIMER_V_COUNT = 0xaa;

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
  /**
   * The sound hardware, which is `@demake/chip`'s and not a second copy.
   *
   * It is handed the console's RAM for the same reason {@link Display} is: this
   * machine has no memory of its own anywhere: the four waveforms are sixty-four
   * bytes of the same sixty-four kilobytes a game's variables are in, read
   * through a base register that carries bits 6–13 of an address.
   */
  readonly sound = new WsSound({ ram: this.ram });

  /**
   * Every write the sound hardware receives, for the conformance oracle.
   *
   * The window doc 16's Level A proof reads. It *observes* rather than
   * intercepts: the chip receives the write either way, so an oracle watching
   * through it cannot change what the hardware saw.
   */
  soundTap: ((reg: number, value: number) => void) | undefined = undefined;

  /**
   * Where the chip's output goes, when anything wants it.
   *
   * Left unset the chip still receives every write and keeps its state; it is
   * only the integration that is skipped, which is what makes a conformance run
   * cost nothing for audio it does not listen to.
   */
  audioSink: SampleSink | undefined = undefined;
  /** The cartridge image, from its first byte. */
  readonly rom: Uint8Array;
  /** Battery RAM, which nothing demade here uses but the map has to answer for. */
  readonly save = new Uint8Array(0x10000);

  /** Ports nothing in this model interprets, kept so a read-back is honest. */
  private readonly ports = new Uint8Array(0x100);

  private held = 0;
  private keyGroup = 0;
  /** The two timers' current counts, and the cycles owed to the scanline one. */
  private hCount = 0;
  private vCount = 0;
  private hCycles = 0;
  private lastLine = 0;

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
    // The counters read back where the reloads were written, which is the whole
    // point of them: a driver asks how many frames have passed rather than
    // being told.
    if (at === TIMER_H_COUNT) return this.hCount & 0xff;
    if (at === TIMER_H_COUNT + 1) return (this.hCount >> 8) & 0xff;
    if (at === TIMER_V_COUNT) return this.vCount & 0xff;
    if (at === TIMER_V_COUNT + 1) return (this.vCount >> 8) & 0xff;
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
    if (at >= WS_SOUND_PORT_FIRST && at <= WS_SOUND_PORT_LAST) {
      this.sound.write(at, byte);
      this.soundTap?.(at, byte);
      return;
    }
    // Writing a reload initialises the counter with it, which is what makes a
    // driver's first read meaningful rather than whatever the timer held.
    if (at === TIMER_H_RELOAD || at === TIMER_H_RELOAD + 1) {
      this.hCount = this.reloadOf(TIMER_H_RELOAD);
      return;
    }
    if (at === TIMER_V_RELOAD || at === TIMER_V_RELOAD + 1) {
      this.vCount = this.reloadOf(TIMER_V_RELOAD);
      return;
    }
    if (at === KEYPAD) this.keyGroup = byte & 0x70;
  }

  /** A timer's sixteen-bit reload, as the two bytes a program wrote. */
  private reloadOf(port: number): number {
    return (this.ports[port] as number) | ((this.ports[port + 1] as number) << 8);
  }

  /**
   * Step both timers by the cycles just spent.
   *
   * The horizontal one counts scanlines and the vertical one counts frames, so
   * one is cycles divided and the other is an edge of the display's own line
   * counter. Neither raises anything here: this console's interrupt controller
   * is absent (`index.ts` §Deliberately absent), and a counter is what a demade
   * cartridge reads anyway.
   */
  private stepTimers(cycles: number): void {
    const control = this.ports[TIMER_CONTROL] as number;
    if ((control & 0x01) !== 0) {
      this.hCycles += cycles;
      while (this.hCycles >= CYCLES_PER_LINE) {
        this.hCycles -= CYCLES_PER_LINE;
        this.hCount = this.tick(this.hCount, this.reloadOf(TIMER_H_RELOAD), (control & 0x02) !== 0);
      }
    }
    const line = this.display.line;
    if (line !== this.lastLine) {
      // The vertical timer decrements at the *start* of the blanking interval,
      // so the edge into line 144 is the event and not the frame boundary.
      if (line === VBLANK_LINE && (control & 0x04) !== 0) {
        this.vCount = this.tick(this.vCount, this.reloadOf(TIMER_V_RELOAD), (control & 0x08) !== 0);
      }
      this.lastLine = line;
    }
  }

  /** One decrement, reloading where the timer repeats and stopping where not. */
  private tick(count: number, reload: number, repeat: boolean): number {
    if (count <= 1) return repeat ? reload & 0xffff : 0;
    return (count - 1) & 0xffff;
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
    this.stepTimers(cycles);
    // The chip's clock *is* the CPU's, so a cycle spent is a clock delivered and
    // there is no ratio to carry — the one console here where the two agree.
    if (this.audioSink) this.sound.run(cycles, this.audioSink);
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
