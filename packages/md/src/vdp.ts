/**
 * The Mega Drive's video display processor, as much of it as a demade game uses.
 *
 * The counterpart of `@demake/sms`'s `Vdp` and `@demake/nes`'s `Ppu`, and it has
 * the same job: be right about the things the compiler's warnings and the art
 * path are written against, so that a cartridge which passes here is a cartridge
 * that draws the same picture on hardware.
 *
 * Four of this chip's properties are load-bearing for the backend above it:
 *
 *   - **A name-table entry is a word, and everything is in it.** Priority,
 *     a two-bit palette select, both flip bits and an eleven-bit tile index —
 *     which is why the image engine's flip-aware fitter can be used whole here,
 *     and why a cell's palette is a property of the cell rather than of a 16×16
 *     block as it is on the NES.
 *   - **Colour zero is transparent on every layer, including the background.**
 *     A background pixel of index 0 shows whatever register 7 points at, not the
 *     palette's own first entry. That is why the console spec calls index 0 a
 *     shared backdrop and why a caption's "paper" is the backdrop rather than
 *     something the font's palette can choose.
 *   - **The planes are bigger than the screen.** 64×32 cells against 40×28, so a
 *     scrolling scene has twenty-four spare columns and four spare rows and the
 *     runtime never has to hide a seam — the thing the Master System's
 *     thirty-two-column table forces it to do.
 *   - **Scrolling is a table in VRAM and a separate RAM.** Horizontal scroll is
 *     read out of VRAM at the address register 13 names; vertical scroll lives
 *     in its own 40-word VSRAM. Both are full-screen here, because a game does
 *     not ask for a raster effect.
 *
 * Sources: Sega — Genesis Software Manual (§VDP) and Plutiedev's VDP notes
 * (https://plutiedev.com/vdp-registers, https://plutiedev.com/vdp-planes).
 */

/** Visible pixels in H40 mode, which is the only one a game is built for. */
export const FRAME_WIDTH = 320;

/** Visible lines in NTSC. */
export const FRAME_HEIGHT = 224;

/** Lines in one NTSC frame, active and blanking. */
export const LINES_PER_FRAME = 262;

/**
 * CPU cycles in one scanline.
 *
 * The 68000 runs at the master clock divided by seven and a line is 3420 master
 * cycles in H40, so this is 488 and a bit; the remainder is not modelled,
 * because nothing here is cycle-exact and a frame that is a few hundred cycles
 * short would only move the interrupt, not lose it.
 */
export const CYCLES_PER_LINE = 488;

/** Entries the colour RAM holds: four palettes of sixteen. */
export const CRAM_ENTRIES = 64;

/** One decoded picture. */
export interface Frame {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Expand a three-bit VDP colour code to eight bits by replicating it. */
function expand(code: number): number {
  const value = code & 7;
  return ((value << 5) | (value << 2) | (value >> 1)) & 0xff;
}

/** A Mega Drive VDP with 64 KiB of video RAM. */
export class Vdp {
  readonly regs = new Uint8Array(24);
  readonly vram = new Uint8Array(0x10000);
  readonly cram = new Uint16Array(CRAM_ENTRIES);
  readonly vsram = new Uint16Array(40);

  /** The current access address, and what kind of access it is. */
  address = 0;
  code = 0;
  /** Whether the first of the control port's two words has been seen. */
  private pending = false;

  /** The line the raster is on. */
  line = 0;
  /** True while the raster is outside the active display. */
  vblank = false;
  /** Set when a vertical interrupt is owed and not yet taken. */
  vintPending = false;

  private readonly pixels = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);

  /** Whether the display is on — register 1, bit 6. */
  get displayOn(): boolean {
    return ((this.regs[1] as number) & 0x40) !== 0;
  }

  /** Whether the vertical interrupt is armed — register 1, bit 5. */
  get vintEnabled(): boolean {
    return ((this.regs[1] as number) & 0x20) !== 0;
  }

  /** How far the access address moves after each data-port access. */
  private get increment(): number {
    return this.regs[15] as number;
  }

  // --- ports -----------------------------------------------------------------

  /**
   * A word written to the control port.
   *
   * Two shapes share the port and the top two bits tell them apart: `10` in bits
   * 15–14 is a register write, anything else is the first half of an address
   * setup. A register write also clears the half-written state, which is what
   * makes a handler that programs a register in the middle of somebody's address
   * setup a bug rather than a corruption — the Sega 8-bits have the same hazard
   * and it bit this project once already.
   */
  writeControl(word: number): void {
    const value = word & 0xffff;
    if (!this.pending && (value & 0xe000) === 0x8000) {
      const register = (value >> 8) & 0x1f;
      if (register < this.regs.length) this.regs[register] = value & 0xff;
      return;
    }
    if (!this.pending) {
      this.address = (this.address & 0xc000) | (value & 0x3fff);
      this.code = (this.code & 0x3c) | ((value >> 14) & 3);
      this.pending = true;
      return;
    }
    this.pending = false;
    this.address = (this.address & 0x3fff) | ((value & 3) << 14);
    this.code = (this.code & 3) | ((value >> 2) & 0x3c);
  }

  /**
   * The status word, and the side effect of reading it.
   *
   * Reading clears the half-written address state — which is why every routine
   * that acknowledges the interrupt has to be somewhere an address setup is not
   * half done. FIFO-empty is always reported, because nothing here models the
   * write queue and a program that waited for it would otherwise hang.
   */
  readControl(): number {
    this.pending = false;
    return 0x3600 | (this.vblank ? 0x08 : 0x00);
  }

  /** A word written to the data port, at the address the control port set. */
  writeData(word: number): void {
    const value = word & 0xffff;
    switch (this.code & 0x0f) {
      case 1: {
        // VRAM. A word write to an odd address swaps the bytes on real silicon;
        // nothing here writes one, and reproducing it would hide the mistake.
        const at = this.address & 0xffff;
        this.vram[at] = (value >> 8) & 0xff;
        this.vram[(at + 1) & 0xffff] = value & 0xff;
        break;
      }
      case 3:
        this.cram[(this.address >> 1) % CRAM_ENTRIES] = value & 0x0eee;
        break;
      case 5:
        this.vsram[(this.address >> 1) % this.vsram.length] = value & 0x3ff;
        break;
      default:
        break;
    }
    this.address = (this.address + this.increment) & 0xffff;
  }

  /** A word read back from wherever the address points. */
  readData(): number {
    let value = 0;
    switch (this.code & 0x0f) {
      case 0: {
        const at = this.address & 0xffff;
        value = ((this.vram[at] as number) << 8) | (this.vram[(at + 1) & 0xffff] as number);
        break;
      }
      case 8:
        value = this.cram[(this.address >> 1) % CRAM_ENTRIES] as number;
        break;
      case 4:
        value = this.vsram[(this.address >> 1) % this.vsram.length] as number;
        break;
      default:
        break;
    }
    this.address = (this.address + this.increment) & 0xffff;
    return value;
  }

  // --- rendering -------------------------------------------------------------

  /** Cells the scroll planes are wide, from register 16. */
  private get planeWidth(): number {
    return [32, 64, 64, 128][(this.regs[16] as number) & 3] as number;
  }

  /** Cells they are tall. */
  private get planeHeight(): number {
    return [32, 64, 64, 128][((this.regs[16] as number) >> 4) & 3] as number;
  }

  /** One pixel of a 4bpp tile, left pixel in the high nibble. */
  private tilePixel(tile: number, x: number, y: number): number {
    const at = (tile * 32 + y * 4 + (x >> 1)) & 0xffff;
    const byte = this.vram[at] as number;
    return (x & 1) === 0 ? byte >> 4 : byte & 0x0f;
  }

  /** A cell word's pixel at a position inside it, flips applied. */
  private cellPixel(cell: number, x: number, y: number): number {
    const tile = cell & 0x07ff;
    const px = (cell & 0x0800) !== 0 ? 7 - x : x;
    const py = (cell & 0x1000) !== 0 ? 7 - y : y;
    return this.tilePixel(tile, px, py);
  }

  /** Render the visible frame into the RGBA buffer. */
  render(): void {
    const backdrop = this.cram[(this.regs[7] as number) & 0x3f] as number;
    const planeW = this.planeWidth;
    const planeH = this.planeHeight;
    const nameA = ((this.regs[2] as number) & 0x38) << 10;
    const hscrollBase = ((this.regs[13] as number) & 0x3f) << 10;
    // Full-screen scroll: the first entry of the table is plane A's, and VSRAM's
    // first word is the whole plane's vertical offset. A game does not ask for a
    // raster effect, so the per-line and per-cell modes are not modelled.
    const hscroll =
      (((this.vram[hscrollBase] as number) << 8) | (this.vram[hscrollBase + 1] as number)) & 0x3ff;
    const vscroll = (this.vsram[0] as number) & 0x3ff;

    const on = this.displayOn;
    const sprites = on ? this.spriteLayer() : undefined;

    for (let y = 0; y < FRAME_HEIGHT; y += 1) {
      for (let x = 0; x < FRAME_WIDTH; x += 1) {
        let colour = backdrop;
        let backgroundPriority = false;
        if (on) {
          const px = (x - hscroll + planeW * 8 * 2) % (planeW * 8);
          const py = (y + vscroll + planeH * 8 * 2) % (planeH * 8);
          const cellAt = nameA + (((py >> 3) * planeW + (px >> 3)) << 1);
          const cell =
            ((this.vram[cellAt & 0xffff] as number) << 8) |
            (this.vram[(cellAt + 1) & 0xffff] as number);
          const index = this.cellPixel(cell, px & 7, py & 7);
          backgroundPriority = (cell & 0x8000) !== 0 && index !== 0;
          if (index !== 0) colour = this.cram[(((cell >> 13) & 3) << 4) | index] as number;
        }
        if (sprites) {
          const entry = sprites[y * FRAME_WIDTH + x] as number;
          // A sprite pixel wins unless the background cell it lands on asked for
          // priority and the sprite did not.
          if (entry !== 0 && (!backgroundPriority || (entry & 0x8000) !== 0)) {
            colour = this.cram[entry & 0x3f] as number;
          }
        }
        const at = (y * FRAME_WIDTH + x) * 4;
        this.pixels[at] = expand(colour >> 1);
        this.pixels[at + 1] = expand(colour >> 5);
        this.pixels[at + 2] = expand(colour >> 9);
        this.pixels[at + 3] = 0xff;
      }
    }
  }

  /**
   * Flatten the sprite list into a per-pixel layer.
   *
   * The list is a linked one — each entry names the next, and a link of zero
   * ends it — so a runtime that parked a sprite by moving it off screen without
   * fixing the links would still walk the whole table. Entries are drawn in list
   * order and the first one to cover a pixel keeps it, which is the hardware's
   * priority rule.
   */
  private spriteLayer(): Uint16Array {
    const layer = new Uint16Array(FRAME_WIDTH * FRAME_HEIGHT);
    const table = ((this.regs[5] as number) & 0x7f) << 9;
    let index = 0;
    for (let drawn = 0; drawn < 80; drawn += 1) {
      const at = (table + index * 8) & 0xffff;
      const y = (((this.vram[at] as number) << 8) | (this.vram[at + 1] as number)) & 0x3ff;
      const size = this.vram[at + 2] as number;
      const link = (this.vram[at + 3] as number) & 0x7f;
      const attribute = ((this.vram[at + 4] as number) << 8) | (this.vram[at + 5] as number);
      const x = (((this.vram[at + 6] as number) << 8) | (this.vram[at + 7] as number)) & 0x1ff;
      const cellsWide = ((size >> 2) & 3) + 1;
      const cellsHigh = (size & 3) + 1;
      const tile = attribute & 0x07ff;
      const palette = (attribute >> 13) & 3;
      const priority = (attribute & 0x8000) !== 0;
      const hflip = (attribute & 0x0800) !== 0;
      const vflip = (attribute & 0x1000) !== 0;

      for (let cy = 0; cy < cellsHigh; cy += 1) {
        for (let cx = 0; cx < cellsWide; cx += 1) {
          // Tiles inside a multi-cell sprite run down the columns first.
          const which =
            tile +
            (hflip ? cellsWide - 1 - cx : cx) * cellsHigh +
            (vflip ? cellsHigh - 1 - cy : cy);
          for (let py = 0; py < 8; py += 1) {
            const screenY = y - 128 + cy * 8 + py;
            if (screenY < 0 || screenY >= FRAME_HEIGHT) continue;
            for (let px = 0; px < 8; px += 1) {
              const screenX = x - 128 + cx * 8 + px;
              if (screenX < 0 || screenX >= FRAME_WIDTH) continue;
              const slot = screenY * FRAME_WIDTH + screenX;
              if (layer[slot] !== 0) continue;
              const value = this.tilePixel(which, hflip ? 7 - px : px, vflip ? 7 - py : py);
              if (value === 0) continue;
              layer[slot] = ((priority ? 1 : 0) << 15) | (palette << 4) | value;
            }
          }
        }
      }

      if (link === 0) break;
      index = link;
    }
    return layer;
  }

  /** The picture, as RGBA. */
  view(): Frame {
    this.render();
    return { pixels: this.pixels, width: FRAME_WIDTH, height: FRAME_HEIGHT };
  }
}
