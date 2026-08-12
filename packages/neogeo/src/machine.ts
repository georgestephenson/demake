/**
 * The Neo Geo around its processor: memory, the cartridge, and the boot ROM's
 * job.
 *
 * Four things about this machine decide the shape of this file.
 *
 *   - **The boot ROM is ours, and it is three lines.** SNK's is not something
 *     this project ships, and a demade cartridge needs almost nothing from it:
 *     take the stack pointer from the first longword of the P ROM, and enter at
 *     the header's `USER` entry, which is a `JMP` the cartridge supplies. That is
 *     the same bargain `@demake/snes` makes about the sound processor's boot ROM
 *     and `@demake/ngp` about SNK's other console — implement the *documented*
 *     hand-off rather than transcribe somebody's code. A commercial cartridge
 *     calls into the system ROM constantly (its font, its soft dips, its coin
 *     handling); a cartridge this project writes calls none of it, which is what
 *     makes the surface three lines rather than eight kilobytes.
 *   - **The watchdog is real and is modelled.** Writing any value to `$300001`
 *     resets a counter that reboots the machine after roughly eight frames. It
 *     is modelled rather than ignored precisely because forgetting it is a class
 *     of bug in *generated* code: the cartridge would be perfect and the console
 *     would sit in a reset loop, which is a symptom no trace can name.
 *   - **The 68000 is `@demake/md`'s.** Two consoles in the set run this
 *     processor, so the CPU is imported the way `@demake/nds` imports
 *     `@demake/gba`'s ARM rather than transcribed a second time.
 *   - **Vertical blank is interrupt level 1**, so its autovector is `$64` — not
 *     the level 6 a Mega Drive uses. Autovector `N` lives at `$60 + N × 4`, and
 *     that arithmetic is the whole difference.
 *
 * **The Z80 sound processor is a whole second computer with its own ROM**, and it
 * is in `sound.ts` rather than here for the same reason `@demake/snes`'s S-SMP is
 * in a file of its own: nothing about it is on this bus. The 68000 reaches it
 * through exactly one byte — a store to `REG_SOUND` at `$320000`, which the
 * hardware latches and turns into a non-maskable interrupt over there — and reads
 * one byte back at `$320001`. The memory card, the calendar and the sprite
 * shrinking hardware are still absent rather than half-implemented.
 *
 * Sources:
 * - Neo Geo Development Wiki — Memory mapped registers:
 *   https://wiki.neogeodev.org/index.php?title=Memory_mapped_registers
 * - Neo Geo Development Wiki — 68k program header:
 *   https://wiki.neogeodev.org/index.php?title=68k_program_header
 * - Neo Geo Development Wiki — Watchdog: https://wiki.neogeodev.org/index.php?title=Watchdog
 */

import {
  NEO_CONTAINER_HEADER,
  swapNeoProgram,
  unpackNeoCharacters,
  unpackNeoFix,
} from "@demake/core";
import { M68k, type Bus } from "@demake/md";

import { FRAME_HEIGHT, Lspc, type Frame, type LspcOptions } from "./lspc.js";
import { Sound } from "./sound.js";

/** The 68000's clock. */
export const CPU_HZ = 12_000_000;
/** Scanlines in an NTSC frame, of which the first 224 are visible. */
export const LINES_PER_FRAME = 264;
/** 68000 cycles a scanline. 264 × 768 × 59.19 Hz is this console's 12 MHz. */
export const CYCLES_PER_LINE = 768;
/** 68000 cycles in a frame. */
export const FRAME_CYCLES = LINES_PER_FRAME * CYCLES_PER_LINE;

/** Work RAM: 64 KiB at `$100000`. */
export const WORK_RAM_BASE = 0x100000;
export const WORK_RAM_SIZE = 0x10000;

/** Palette RAM, one bank visible at a time. */
export const PALETTE_BASE = 0x400000;

/** The one byte the 68000 sends the sound processor, and the one it reads back. */
export const REG_SOUND = 0x320000;

/** Where the cartridge's header lives, and the entry the boot hand-off uses. */
export const HEADER_BASE = 0x100;
/** The `JMP USER` the boot ROM enters through. */
export const USER_ENTRY = 0x122;

/** Vertical blank is interrupt level 1; autovector N is at `$60 + N × 4`. */
export const VBLANK_LEVEL = 1;
export const VBLANK_VECTOR = 0x64;

/** Frames without a watchdog write before the hardware reboots. */
export const WATCHDOG_FRAMES = 8;

/**
 * The controller's bits at `REG_P1CNT`, active low.
 *
 * Centralised for `NGP_BUTTON_BITS`' reason: the cartridge reads this byte
 * through the same declaration a harness writes it through, so a wrong order
 * here is wrong *consistently* and passes every test there is. These are the
 * documented assignments rather than a guess, but they get one home anyway.
 */
export const BUTTONS = {
  up: 0x01,
  down: 0x02,
  left: 0x04,
  right: 0x08,
  a: 0x10,
  b: 0x20,
  c: 0x40,
  d: 0x80,
} as const;

/** Start and select live in `REG_STATUS_B`, also active low. */
export const SYSTEM_BUTTONS = { start: 0x01, select: 0x02 } as const;

export type Button = keyof typeof BUTTONS | keyof typeof SYSTEM_BUTTONS;

/** What a cartridge is: ROMs the hardware reads from different buses. */
export interface Cartridge {
  /** The 68000's program. */
  program: Uint8Array;
  /** Sprite tile pixels, one byte a pixel, 256 bytes a 16×16 tile. */
  characters: Uint8Array;
  /** Fix layer tile pixels, one byte a pixel, 64 bytes an 8×8 tile. */
  fixCharacters: Uint8Array;
  /** The Z80's program, which is a *different processor's* ROM on its own bus. */
  sound: Uint8Array;
  /** The ADPCM-A sample ROM the six fixed-rate voices read. */
  samplesA: Uint8Array;
  /** The ADPCM-B sample ROM the one variable-rate voice reads. */
  samplesB: Uint8Array;
}

/**
 * Split a `.neo` container into the regions the hardware reads.
 *
 * The graphics arrive **packed** and are decoded here rather than being handed
 * over ready-made, which is deliberate: `packNeoCharacters` has a
 * right-half-before-left block order that a core reading decoded pixels would
 * never exercise, so a cartridge this project writes is only proven to carry
 * hardware bytes if something unpacks them the hardware's way. The encoders are
 * pinned independently by hand-computed offsets in
 * `packages/core/test/neo-cart.test.ts`; this is the other half of that.
 */
export function loadNeo(image: Uint8Array): Cartridge {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (String.fromCharCode(image[0] ?? 0, image[1] ?? 0, image[2] ?? 0) !== "NEO") {
    throw new Error("not a .neo cartridge: the container's magic is missing");
  }
  const pSize = view.getUint32(0x04, true);
  const sSize = view.getUint32(0x08, true);
  const mSize = view.getUint32(0x0c, true);
  const v1Size = view.getUint32(0x10, true);
  const v2Size = view.getUint32(0x14, true);
  const cSize = view.getUint32(0x18, true);

  let at = NEO_CONTAINER_HEADER;
  // The container stores the P ROM byte-swapped, as a MAME set does — see
  // `swapNeoProgram`. Everything above this line is plain big-endian 68000.
  const program = swapNeoProgram(image.subarray(at, at + pSize));
  at += pSize;
  const s = image.subarray(at, at + sSize);
  at += sSize;
  const m = image.subarray(at, at + mSize);
  at += mSize;
  const v1 = image.subarray(at, at + v1Size);
  at += v1Size;
  const v2 = image.subarray(at, at + v2Size);
  at += v2Size;
  const c = image.subarray(at, at + cSize);

  // The pair is interleaved a byte at a time, odd ROM at even offsets.
  const half = c.length >> 1;
  const c1 = new Uint8Array(half);
  const c2 = new Uint8Array(half);
  for (let index = 0; index < half; index += 1) {
    c1[index] = c[index * 2] ?? 0;
    c2[index] = c[index * 2 + 1] ?? 0;
  }
  return {
    program,
    characters: unpackNeoCharacters(c1, c2),
    fixCharacters: unpackNeoFix(s),
    // The other three are read as they lie: a Z80 program and two ADPCM ROMs are
    // bytes on somebody else's bus, with no packing anywhere in them.
    sound: m,
    samplesA: v1,
    samplesB: v2,
  };
}

/**
 * A Neo Geo.
 *
 * Implements {@link Bus} for the imported 68000, exactly as `@demake/md`'s
 * machine does for the same processor.
 */
export class Neogeo implements Bus {
  readonly cpu: M68k;
  readonly lspc: Lspc;
  readonly sound: Sound;
  readonly ram = new Uint8Array(WORK_RAM_SIZE);

  /** Frames completed since reset — the speed measurement's clock. */
  frames = 0;
  /** Frames since the watchdog was last kicked. */
  watchdog = 0;
  /** Set when the watchdog rebooted the machine, so a harness can say so. */
  watchdogTripped = false;

  private readonly program: Uint8Array;
  private buttons = 0;
  private systemButtons = 0;
  private line = 0;
  private lineCycles = 0;

  constructor(cartridge: Cartridge) {
    this.program = cartridge.program;
    const options: LspcOptions = {
      characters: cartridge.characters,
      fixCharacters: cartridge.fixCharacters,
    };
    this.lspc = new Lspc(options);
    this.sound = new Sound(cartridge.sound, cartridge.samplesA, cartridge.samplesB);
    this.cpu = new M68k(this);
    this.boot();
  }

  /**
   * The boot ROM's hand-off, and the whole of what this core implements of it.
   *
   * Stack pointer from the P ROM's first longword, then enter at the header's
   * `JMP USER`. Nothing else the system ROM does is anything a demade cartridge
   * observes: it draws no eyecatcher, reads no soft dips, and takes no coins.
   */
  private boot(): void {
    // `reset()` already takes the stack pointer from the first longword, which
    // on this console is the cartridge's and is exactly what the documented
    // hand-off does. What it must *not* keep is the program counter it read
    // beside it: `$0004` is a pointer into the system ROM, so a demade cartridge
    // is entered at its own header instead.
    this.cpu.reset();
    this.cpu.pc = USER_ENTRY;
    this.line = 0;
    this.lineCycles = 0;
  }

  /**
   * Set exactly the buttons that are down, which is what a harness drives.
   *
   * Whole-set rather than per-button because a tape says what is held on a tick,
   * and deriving releases from that is the caller's job on no other console.
   */
  setButtons(down: readonly Button[]): void {
    this.buttons = 0;
    this.systemButtons = 0;
    for (const button of down) this.setButton(button, true);
  }

  /** Press or release a button. */
  setButton(button: Button, down: boolean): void {
    if (button in SYSTEM_BUTTONS) {
      const mask = SYSTEM_BUTTONS[button as keyof typeof SYSTEM_BUTTONS];
      this.systemButtons = down ? this.systemButtons | mask : this.systemButtons & ~mask;
      return;
    }
    const mask = BUTTONS[button as keyof typeof BUTTONS];
    this.buttons = down ? this.buttons | mask : this.buttons & ~mask;
  }

  // --- bus -------------------------------------------------------------------

  read8(address: number): number {
    const at = address >>> 0;
    if (at < 0x100000) return this.program[at] ?? 0xff;
    if (at >= WORK_RAM_BASE && at < WORK_RAM_BASE + WORK_RAM_SIZE) {
      return this.ram[at - WORK_RAM_BASE] ?? 0;
    }
    if (at === 0x300000) return (~this.buttons & 0xff) >>> 0;
    if (at === 0x380000) return (~this.systemButtons & 0xff) >>> 0;
    // The odd half of `REG_SOUND` is what the sound processor replied with; the
    // even half is not a readable register at all.
    if (at === REG_SOUND + 1) return this.sound.reply;
    if (at >= PALETTE_BASE && at < PALETTE_BASE + 0x2000) {
      const word = this.readPalette((at - PALETTE_BASE) >> 1);
      return (at & 1) === 0 ? word >> 8 : word & 0xff;
    }
    if (at >= 0x3c0000 && at <= 0x3c000f) {
      const word = this.readLspc(at & ~1);
      return (at & 1) === 0 ? word >> 8 : word & 0xff;
    }
    return 0xff;
  }

  read16(address: number): number {
    const at = address >>> 0;
    if (at < 0x100000) return ((this.program[at] ?? 0xff) << 8) | (this.program[at + 1] ?? 0xff);
    if (at >= WORK_RAM_BASE && at < WORK_RAM_BASE + WORK_RAM_SIZE) {
      const offset = at - WORK_RAM_BASE;
      return ((this.ram[offset] ?? 0) << 8) | (this.ram[offset + 1] ?? 0);
    }
    if (at >= PALETTE_BASE && at < PALETTE_BASE + 0x2000) {
      return this.readPalette((at - PALETTE_BASE) >> 1);
    }
    if (at >= 0x3c0000 && at <= 0x3c000f) return this.readLspc(at);
    if (at === 0x300000) return ((~this.buttons & 0xff) << 8) | (~this.buttons & 0xff);
    if (at === 0x380000) return ((~this.systemButtons & 0xff) << 8) | 0xff;
    return 0xffff;
  }

  write8(address: number, value: number): void {
    const at = address >>> 0;
    const byte = value & 0xff;
    if (at >= WORK_RAM_BASE && at < WORK_RAM_BASE + WORK_RAM_SIZE) {
      this.ram[at - WORK_RAM_BASE] = byte;
      return;
    }
    // The watchdog. Any value, and the address is the odd half of `$300000`.
    if (at === 0x300001) {
      this.watchdog = 0;
      return;
    }
    // One byte to the sound processor, which the hardware latches and turns into
    // a non-maskable interrupt over there. That is the whole request protocol —
    // no handshake, no waiting, and a game that asks for a track pays one store.
    if (at === REG_SOUND) {
      this.sound.send(byte);
      return;
    }
    // System control: byte writes, and the address *is* the command.
    if (at >= 0x3a0000 && at <= 0x3a001f) {
      if (at === 0x3a000f) this.lspc.paletteBank = 1;
      if (at === 0x3a001f) this.lspc.paletteBank = 0;
      return;
    }
    if (at >= PALETTE_BASE && at < PALETTE_BASE + 0x2000) {
      const index = (at - PALETTE_BASE) >> 1;
      const word = this.readPalette(index);
      const merged = (at & 1) === 0 ? (byte << 8) | (word & 0xff) : (word & 0xff00) | byte;
      this.writePalette(index, merged);
      return;
    }
    if (at >= 0x3c0000 && at <= 0x3c000f) {
      const word = this.readLspc(at & ~1);
      const merged = (at & 1) === 0 ? (byte << 8) | (word & 0xff) : (word & 0xff00) | byte;
      this.writeLspc(at & ~1, merged);
    }
  }

  write16(address: number, value: number): void {
    const at = address >>> 0;
    const word = value & 0xffff;
    if (at >= WORK_RAM_BASE && at < WORK_RAM_BASE + WORK_RAM_SIZE) {
      const offset = at - WORK_RAM_BASE;
      this.ram[offset] = word >> 8;
      this.ram[offset + 1] = word & 0xff;
      return;
    }
    if (at >= PALETTE_BASE && at < PALETTE_BASE + 0x2000) {
      this.writePalette((at - PALETTE_BASE) >> 1, word);
      return;
    }
    if (at >= 0x3c0000 && at <= 0x3c000f) {
      this.writeLspc(at, word);
      return;
    }
    if (at === 0x300000) this.watchdog = 0;
    if (at === REG_SOUND) this.sound.send(word >> 8);
    if (at >= 0x3a0000 && at <= 0x3a001f) this.write8(at | 1, word & 0xff);
  }

  private readPalette(index: number): number {
    return this.lspc.palettes[this.lspc.paletteBank]![index] ?? 0;
  }

  private writePalette(index: number, word: number): void {
    this.lspc.palettes[this.lspc.paletteBank]![index] = word;
  }

  private readLspc(address: number): number {
    if (address === 0x3c0000) return this.lspc.address;
    if (address === 0x3c0002) return this.lspc.readData();
    if (address === 0x3c0004) return this.lspc.modulo;
    return 0;
  }

  private writeLspc(address: number, word: number): void {
    if (address === 0x3c0000) this.lspc.address = word;
    else if (address === 0x3c0002) this.lspc.writeData(word);
    else if (address === 0x3c0004) this.lspc.modulo = (word << 16) >> 16;
  }

  // --- running ---------------------------------------------------------------

  /** One instruction, and whatever the raster did while it ran. */
  stepInstruction(): number {
    const cycles = this.cpu.step();
    // The other processor runs on the same wall clock and on nothing this one
    // can see, so it is advanced by the cycles this instruction spent rather
    // than by a frame: its own tick is the sound chip's timer.
    this.sound.run(cycles);
    this.lineCycles += cycles;
    while (this.lineCycles >= CYCLES_PER_LINE) {
      this.lineCycles -= CYCLES_PER_LINE;
      this.line += 1;
      if (this.line === FRAME_HEIGHT) {
        this.cpu.interrupt(VBLANK_LEVEL, VBLANK_VECTOR);
      }
      if (this.line >= LINES_PER_FRAME) {
        this.line = 0;
        this.frames += 1;
        this.watchdog += 1;
        if (this.watchdog > WATCHDOG_FRAMES) {
          this.watchdogTripped = true;
          this.watchdog = 0;
          this.boot();
        }
      }
    }
    return cycles;
  }

  /** Run to the start of the next vertical blank; the speed measurement's clock. */
  runFrame(): number {
    const target = this.frames + 1;
    let cycles = 0;
    for (let guard = 0; guard < 4_000_000 && this.frames < target; guard += 1) {
      cycles += this.stepInstruction();
    }
    return cycles;
  }

  /** Draw the current state. */
  render(): Frame {
    return this.lspc.render();
  }

  /** Read a run of bytes out of the console's address space. */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.read8(address + index);
    return out;
  }
}
