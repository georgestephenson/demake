/**
 * The Game Boy around the processor: memory map, PPU, timer, and joypad.
 *
 * Enough hardware to run a `demake build` ROM faithfully and nothing more. The
 * PPU is a scanline renderer on the published 456-dot line — mode 2 for 80,
 * mode 3 for 172, mode 0 for the rest, ten lines of VBlank — because a
 * per-scanline picture is what a fixed-tick game needs and a pixel-FIFO would
 * buy accuracy no demade game can observe.
 *
 * Two things are deliberately absent. There is no MBC: a build is 32 KiB, and
 * the day a game needs banking the runtime gains a mapper and this gains the
 * three lines to match. And VRAM is *not* blocked outside VBlank — a real DMG
 * drops those writes, and the runtime is written to do its VRAM work in the
 * VBlank window regardless, so modelling the block here would only convert a
 * discipline failure into a mystery. The SameBoy E2E is where that gets caught.
 */

import { type Bus, Cpu, INT } from "./cpu.js";

/** Visible framebuffer size. */
export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;

/** T-cycles in one frame: 154 lines × 456 dots. */
export const FRAME_CYCLES = 70224;

/** Joypad buttons, in the order the hardware reports them. */
export const BUTTONS = ["right", "left", "up", "down", "a", "b", "select", "start"] as const;

/** One joypad button. */
export type Button = (typeof BUTTONS)[number];

/** The four DMG shades, darkest last, as 8-bit grey. */
const SHADES = [0xe8, 0xa0, 0x58, 0x10];

/** A DMG with a 32 KiB cartridge in it. */
export class Gameboy implements Bus {
  readonly cpu = new Cpu(this);
  readonly rom: Uint8Array;
  readonly vram = new Uint8Array(0x2000);
  readonly wram = new Uint8Array(0x2000);
  readonly oam = new Uint8Array(0xa0);
  readonly hram = new Uint8Array(0x7f);
  readonly io = new Uint8Array(0x80);
  private interruptEnable = 0;

  /** One byte per pixel: the shade index 0–3, before palette colouring. */
  readonly indices = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  /** RGBA, ready for `putImageData`. */
  readonly framebuffer = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);

  /** Raw background colour indices for the line being drawn, for OBJ priority. */
  private readonly bgRow = new Uint8Array(SCREEN_WIDTH);
  private dot = 0;
  private divCounter = 0;
  private timerCounter = 0;
  private held = 0;
  /** Frames completed since power-on — the harness's clock. */
  frames = 0;

  constructor(rom: Uint8Array) {
    this.rom = rom;
    // Post-boot-ROM register state, so a cartridge that assumes the boot ROM ran
    // sees what it expects without us shipping Nintendo's copyrighted code.
    this.io[0x00] = 0xcf;
    this.io[0x05] = 0x00;
    this.io[0x06] = 0x00;
    this.io[0x07] = 0x00;
    this.io[0x0f] = 0xe1;
    this.io[0x40] = 0x91;
    this.io[0x41] = 0x85;
    this.io[0x44] = 0x00;
    this.io[0x47] = 0xfc;
    this.io[0x48] = 0xff;
    this.io[0x49] = 0xff;
    this.framebuffer.fill(0xff);
  }

  // --- bus -------------------------------------------------------------------

  read(address: number): number {
    const at = address & 0xffff;
    if (at < 0x8000) return this.rom[at] ?? 0xff;
    if (at < 0xa000) return this.vram[at - 0x8000] as number;
    if (at < 0xc000) return 0xff; // no cartridge RAM
    if (at < 0xe000) return this.wram[at - 0xc000] as number;
    if (at < 0xfe00) return this.wram[at - 0xe000] as number; // echo
    if (at < 0xfea0) return this.oam[at - 0xfe00] as number;
    if (at < 0xff00) return 0xff;
    if (at < 0xff80) return this.readIo(at - 0xff00);
    if (at < 0xffff) return this.hram[at - 0xff80] as number;
    return this.interruptEnable;
  }

  write(address: number, value: number): void {
    const at = address & 0xffff;
    const byte = value & 0xff;
    if (at < 0x8000) return; // ROM is read-only; no mapper to poke
    if (at < 0xa000) {
      this.vram[at - 0x8000] = byte;
      return;
    }
    if (at < 0xc000) return;
    if (at < 0xe000) {
      this.wram[at - 0xc000] = byte;
      return;
    }
    if (at < 0xfe00) {
      this.wram[at - 0xe000] = byte;
      return;
    }
    if (at < 0xfea0) {
      this.oam[at - 0xfe00] = byte;
      return;
    }
    if (at < 0xff00) return;
    if (at < 0xff80) {
      this.writeIo(at - 0xff00, byte);
      return;
    }
    if (at < 0xffff) {
      this.hram[at - 0xff80] = byte;
      return;
    }
    this.interruptEnable = byte;
  }

  private readIo(register: number): number {
    switch (register) {
      case 0x00:
        return this.joypadRegister();
      case 0x0f:
        return (this.io[0x0f] as number) | 0xe0;
      default:
        return this.io[register] as number;
    }
  }

  private writeIo(register: number, value: number): void {
    switch (register) {
      case 0x04:
        // Any write resets the divider, and with it the timer's prescaler.
        this.io[0x04] = 0;
        this.divCounter = 0;
        return;
      case 0x44:
        return; // LY is read-only
      case 0x46: {
        // OAM DMA. Real hardware takes 160 machine cycles and locks the bus;
        // nothing a demade game does can observe the difference, so it is
        // instant here and the cycles are still charged by the caller.
        const source = value << 8;
        for (let index = 0; index < 0xa0; index += 1) {
          this.oam[index] = this.read(source + index);
        }
        this.io[0x46] = value;
        return;
      }
      default:
        this.io[register] = value;
    }
  }

  // --- joypad ----------------------------------------------------------------

  /** Set which buttons are down. Reads are level-sensitive, so this is state. */
  setButtons(down: Iterable<Button>): void {
    let mask = 0;
    for (const button of down) {
      const index = BUTTONS.indexOf(button);
      if (index >= 0) mask |= 1 << index;
    }
    this.held = mask;
  }

  private joypadRegister(): number {
    const select = (this.io[0x00] as number) & 0x30;
    let low = 0x0f;
    // Both lines can be selected at once, and the hardware ANDs the results.
    if ((select & 0x10) === 0) low &= ~((this.held >> 0) & 0x0f) & 0x0f;
    if ((select & 0x20) === 0) low &= ~((this.held >> 4) & 0x0f) & 0x0f;
    return 0xc0 | select | low;
  }

  // --- timing ----------------------------------------------------------------

  private request(bit: number): void {
    this.io[0x0f] = ((this.io[0x0f] as number) | bit) & 0x1f;
  }

  /** Run one instruction (or an interrupt dispatch) and clock the hardware. */
  stepInstruction(): number {
    let cycles = this.cpu.serviceInterrupts(
      this.interruptEnable,
      this.io[0x0f] as number,
      (bit) => {
        this.io[0x0f] = (this.io[0x0f] as number) & ~bit & 0x1f;
      },
    );
    if (cycles === 0) cycles = this.cpu.step();
    this.advance(cycles);
    return cycles;
  }

  /** Run until the start of the next VBlank, and return the frame index. */
  runFrame(): number {
    const target = this.frames + 1;
    let guard = 0;
    while (this.frames < target) {
      this.stepInstruction();
      // A runtime that hangs must fail the harness rather than the process.
      if ((guard += 1) > 4_000_000) throw new Error("dmg: no VBlank after 4M instructions");
    }
    return this.frames;
  }

  private advance(cycles: number): void {
    this.clockTimer(cycles);
    this.clockPpu(cycles);
  }

  private clockTimer(cycles: number): void {
    this.divCounter += cycles;
    while (this.divCounter >= 256) {
      this.divCounter -= 256;
      this.io[0x04] = (((this.io[0x04] as number) + 1) & 0xff) as number;
    }
    const control = this.io[0x07] as number;
    if ((control & 4) === 0) return;
    const period = [1024, 16, 64, 256][control & 3] as number;
    this.timerCounter += cycles;
    while (this.timerCounter >= period) {
      this.timerCounter -= period;
      const next = ((this.io[0x05] as number) + 1) & 0xff;
      if (next === 0) {
        this.io[0x05] = this.io[0x06] as number;
        this.request(INT.timer);
      } else {
        this.io[0x05] = next;
      }
    }
  }

  private clockPpu(cycles: number): void {
    if (((this.io[0x40] as number) & 0x80) === 0) {
      // LCD off: the counter parks at line 0 in mode 0, as on hardware.
      this.dot = 0;
      this.io[0x44] = 0;
      this.io[0x41] = (this.io[0x41] as number) & ~3;
      return;
    }
    this.dot += cycles;
    while (this.dot >= 456) {
      this.dot -= 456;
      const line = (this.io[0x44] as number) + 1;
      if (line < SCREEN_HEIGHT) {
        this.io[0x44] = line;
        this.renderLine(line);
      } else if (line === SCREEN_HEIGHT) {
        this.io[0x44] = line;
        this.request(INT.vblank);
        this.frames += 1;
        this.present();
      } else if (line > 153) {
        this.io[0x44] = 0;
        this.renderLine(0);
      } else {
        this.io[0x44] = line;
      }
      this.updateStat();
    }
  }

  private updateStat(): void {
    const line = this.io[0x44] as number;
    const status = this.io[0x41] as number;
    const mode = line >= SCREEN_HEIGHT ? 1 : this.dot < 80 ? 2 : this.dot < 252 ? 3 : 0;
    const coincidence = line === (this.io[0x45] as number);
    this.io[0x41] = (status & ~0x07) | (coincidence ? 4 : 0) | mode;
    const wanted =
      (coincidence && (status & 0x40) !== 0) ||
      (mode === 0 && (status & 0x08) !== 0) ||
      (mode === 1 && (status & 0x10) !== 0) ||
      (mode === 2 && (status & 0x20) !== 0);
    if (wanted) this.request(INT.stat);
  }

  // --- rendering -------------------------------------------------------------

  /**
   * Draw one scanline: background, then window, then sprites.
   *
   * Sprite priority on a DMG is by X coordinate and then by OAM index, and the
   * ten-per-line limit is real hardware behaviour a demade game is *supposed*
   * to run into — doc 14 §Budgets has the compiler warn about it, so the core
   * must actually enforce it or the warning would be unfalsifiable.
   */
  private renderLine(line: number): void {
    const control = this.io[0x40] as number;
    const row = this.indices.subarray(line * SCREEN_WIDTH, (line + 1) * SCREEN_WIDTH);
    row.fill(0);
    this.bgRow.fill(0);
    if ((control & 0x80) === 0) return;

    const bgp = this.io[0x47] as number;
    const tileBase = (control & 0x10) !== 0 ? 0x0000 : 0x1000;

    if ((control & 0x01) !== 0) {
      const scy = this.io[0x42] as number;
      const scx = this.io[0x43] as number;
      const mapBase = (control & 0x08) !== 0 ? 0x1c00 : 0x1800;
      const y = (line + scy) & 0xff;
      for (let x = 0; x < SCREEN_WIDTH; x += 1) {
        const worldX = (x + scx) & 0xff;
        const index = this.tilePixel(mapBase, tileBase, worldX, y);
        this.bgRow[x] = index;
        row[x] = (bgp >> (index * 2)) & 3;
      }

      // The window, drawn over the background from (WX-7, WY).
      const wy = this.io[0x4a] as number;
      const wx = (this.io[0x4b] as number) - 7;
      if ((control & 0x20) !== 0 && line >= wy && wx < SCREEN_WIDTH) {
        const windowMap = (control & 0x40) !== 0 ? 0x1c00 : 0x1800;
        for (let x = Math.max(0, wx); x < SCREEN_WIDTH; x += 1) {
          const index = this.tilePixel(windowMap, tileBase, x - wx, line - wy);
          this.bgRow[x] = index;
          row[x] = (bgp >> (index * 2)) & 3;
        }
      }
    }

    if ((control & 0x02) === 0) return;
    const tall = (control & 0x04) !== 0 ? 16 : 8;
    const candidates: number[] = [];
    for (let entry = 0; entry < 40 && candidates.length < 10; entry += 1) {
      const top = (this.oam[entry * 4] as number) - 16;
      if (line >= top && line < top + tall) candidates.push(entry);
    }
    // Later entries draw first so that lower-X, lower-index sprites end on top.
    candidates.sort((a, b) => {
      const ax = this.oam[a * 4 + 1] as number;
      const bx = this.oam[b * 4 + 1] as number;
      return ax === bx ? b - a : bx - ax;
    });

    for (const entry of candidates) {
      const top = (this.oam[entry * 4] as number) - 16;
      const left = (this.oam[entry * 4 + 1] as number) - 8;
      const flags = this.oam[entry * 4 + 3] as number;
      let tile = this.oam[entry * 4 + 2] as number;
      if (tall === 16) tile &= 0xfe;
      let inner = line - top;
      if ((flags & 0x40) !== 0) inner = tall - 1 - inner;
      const address = tile * 16 + inner * 2;
      const low = this.vram[address] as number;
      const high = this.vram[address + 1] as number;
      const palette = this.io[(flags & 0x10) !== 0 ? 0x49 : 0x48] as number;
      for (let bit = 0; bit < 8; bit += 1) {
        const x = left + ((flags & 0x20) !== 0 ? 7 - bit : bit);
        if (x < 0 || x >= SCREEN_WIDTH) continue;
        const shift = 7 - bit;
        const index = ((low >> shift) & 1) | (((high >> shift) & 1) << 1);
        if (index === 0) continue; // colour 0 is transparent for sprites
        // OBJ-behind-BG: the sprite loses to background colours 1–3.
        if ((flags & 0x80) !== 0 && (this.bgRow[x] as number) !== 0) continue;
        row[x] = (palette >> (index * 2)) & 3;
      }
    }
  }

  private tilePixel(mapBase: number, tileBase: number, x: number, y: number): number {
    const map = mapBase + ((y >> 3) & 31) * 32 + ((x >> 3) & 31);
    const id = this.vram[map] as number;
    const address = tileBase === 0 ? id * 16 + (y & 7) * 2 : 0x1000 + signed(id) * 16 + (y & 7) * 2;
    const low = this.vram[address] as number;
    const high = this.vram[address + 1] as number;
    const shift = 7 - (x & 7);
    return ((low >> shift) & 1) | (((high >> shift) & 1) << 1);
  }

  /** Colour the finished frame into RGBA. */
  private present(): void {
    for (let pixel = 0; pixel < this.indices.length; pixel += 1) {
      const shade = SHADES[this.indices[pixel] as number] as number;
      const at = pixel * 4;
      this.framebuffer[at] = shade;
      this.framebuffer[at + 1] = shade;
      this.framebuffer[at + 2] = shade;
      this.framebuffer[at + 3] = 0xff;
    }
  }

  /** Read `length` bytes of work RAM from an absolute address. */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.read(address + index);
    return out;
  }
}

function signed(byte: number): number {
  return byte > 127 ? byte - 256 : byte;
}
