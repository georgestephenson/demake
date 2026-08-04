/**
 * The HuC6270 display controller and the HuC6260 colour encoder.
 *
 * Two chips in one file because a picture needs both and neither is useful
 * alone: the VDC decides *which* index every pixel is and the VCE decides what
 * colour an index is, and a program programs them through two register windows
 * eight addresses apart. A scanline renderer, on the same terms as
 * `@demake/nes`'s PPU — enough hardware to run a `demake build` cartridge
 * faithfully and nothing more.
 *
 * What "faithfully" has to include is set by what the generated runtime does, and
 * four of those are load-bearing:
 *
 *   - **Video RAM is words, not bytes, and it is reached through a port.** An
 *     address goes into `MAWR` and data through `VWR`, and the address
 *     auto-increments by whatever `CR` says. Everything a game uploads — the tile
 *     bank, the background map, the sprite table — arrives that way, which is why
 *     the backend's whole renderer is written around one `tia` into `$0002`.
 *   - **A background cell carries its own palette.** A BAT entry is a word: twelve
 *     bits of character and four of palette, so this console needs neither the
 *     NES's 16×16 attribute blocks nor a second VRAM bank for attributes. That is
 *     the constraint the art path is written against.
 *   - **Sprites are 16×16 at their smallest.** There is no 8×8 object on this
 *     machine, so a one-cell game object is a 16×16 sprite with three quarters of
 *     it transparent — and the per-line limit is sixteen *sprites*, not eight,
 *     which is what lets a HUD and a scene's objects coexist.
 *   - **The sprite table is copied, not read.** The VDC keeps its own 256-word
 *     copy and refreshes it from `DVSSR` at the start of a vertical blank. A
 *     runtime that wrote the table and expected it to take effect on the same
 *     frame would be a frame late, which is a real difference from every other
 *     console here.
 *
 * The timing model is deliberately simpler than hardware in one place, exactly as
 * the NES core's is: the scroll registers are sampled once per line rather than
 * per dot. The two are identical for any frame whose scroll is set outside
 * rendering, which is what a fixed-tick game does; a mid-frame split, which
 * nothing here emits, would be visibly wrong rather than subtly wrong.
 *
 * Sources: Archaic Pixels — HuC6270 register reference, HuC6260 colour encoder,
 * and the sprite attribute table format.
 */

/** The framebuffer this core renders, which is the window a demade game uses. */
export const SCREEN_WIDTH = 256;
export const SCREEN_HEIGHT = 224;

/** Lines in one frame, and master clocks in one line. */
export const LINES_PER_FRAME = 262;
export const MASTER_PER_LINE = 1364;

/** VDC registers, by the number a program writes to the address port. */
export const REG = {
  MAWR: 0x00,
  MARR: 0x01,
  VRR: 0x02,
  CR: 0x05,
  RCR: 0x06,
  BXR: 0x07,
  BYR: 0x08,
  MWR: 0x09,
  HSR: 0x0a,
  HDR: 0x0b,
  VPR: 0x0c,
  VDW: 0x0d,
  VCR: 0x0e,
  DCR: 0x0f,
  SOUR: 0x10,
  DESR: 0x11,
  LENR: 0x12,
  DVSSR: 0x13,
} as const;

/** How far the address port steps after a data write, by `CR`'s two bits. */
const INCREMENT = [1, 32, 64, 128] as const;

/** Sprites the hardware evaluates on one line. */
const SPRITES_PER_LINE = 16;

/** Entries in the sprite attribute table. */
const SPRITES = 64;

/**
 * The colour encoder's 512 nine-bit entries, expanded to sRGB.
 *
 * Three bits a channel, replicated into eight — which is what the `pce` console
 * spec's `linear` DAC model says, and `test/vdc.test.ts` pins the two together.
 * A DAC model is a tested artifact here (doc 10), so the in-page player and the
 * CLI's PNG show one palette.
 */
export function expandColor(code: number): readonly [number, number, number] {
  // The hardware packs green above red above blue, which is the one thing about
  // this format that catches everybody: `GGGRRRBBB`.
  const green = (code >> 6) & 7;
  const red = (code >> 3) & 7;
  const blue = code & 7;
  const to8 = (value: number): number => (value << 5) | (value << 2) | (value >> 1);
  return [to8(red), to8(green), to8(blue)];
}

/** The picture hardware: one HuC6270, one HuC6260, and the RAM between them. */
export class Vdc {
  /** 32768 words — the whole of this console's video memory. */
  readonly vram = new Uint16Array(0x8000);
  /** The 512-entry colour table, nine bits each. */
  readonly palette = new Uint16Array(512);
  /** The VDC's own copy of the sprite table, refreshed from VRAM each frame. */
  readonly sat = new Uint16Array(256);

  /** The visible picture, RGBA. */
  readonly framebuffer = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);

  /** Frames finished since power-on — the harness's clock. */
  frames = 0;
  /** The line being rendered, counting from the top of the frame. */
  line = 0;

  /** Whether the interrupt line into the CPU is asserted. */
  irq = false;

  /** The register the address port last selected. */
  private selected = 0;
  private readonly regs = new Uint16Array(0x20);
  /** The status bits a read of the status port reports and clears. */
  private status = 0;
  /** Set when `DVSSR` was written and the table has not been fetched since. */
  private satPending = false;
  /** Master clocks left in the line being rendered. */
  private clocks = 0;
  /** The colour table address, and which half of an entry a write goes to. */
  private colorAddress = 0;

  /** The background scroll, latched per line for the reason the header gives. */
  private lineScrollX = 0;
  private lineScrollY = 0;
  /**
   * `BYR` as the frame started.
   *
   * The chip loads it into an internal counter at the top of the display and
   * counts that up with the raster, so a write lands on the *next* frame — which
   * is exactly what a runtime scrolling in the blanking interval wants, and the
   * reason nothing here re-reads the register per line.
   */
  private byrLatch = 0;

  // --- the register windows --------------------------------------------------

  /** Read one of the VDC's four addresses (`$0000`–`$0003` of the hardware page). */
  readVdc(offset: number): number {
    switch (offset & 3) {
      case 0: {
        // Reading the status acknowledges every bit it reports, which is also
        // how the runtime clears the interrupt it woke on.
        const value = this.status;
        this.status = 0;
        this.irq = false;
        return value;
      }
      case 2:
        return this.readData() & 0xff;
      case 3:
        return (this.readData(true) >> 8) & 0xff;
      default:
        return 0;
    }
  }

  /** Write one of the VDC's four addresses. */
  writeVdc(offset: number, value: number): void {
    const byte = value & 0xff;
    switch (offset & 3) {
      case 0:
        this.selected = byte & 0x1f;
        return;
      case 2:
        this.regs[this.selected] = ((this.regs[this.selected] as number) & 0xff00) | byte;
        this.afterRegister(false);
        return;
      case 3:
        this.regs[this.selected] = ((this.regs[this.selected] as number) & 0x00ff) | (byte << 8);
        this.afterRegister(true);
        return;
      default:
        return;
    }
  }

  /** Read one of the colour encoder's eight addresses. */
  readVce(offset: number): number {
    switch (offset & 7) {
      case 4:
        return (this.palette[this.colorAddress & 0x1ff] as number) & 0xff;
      case 5: {
        const value = ((this.palette[this.colorAddress & 0x1ff] as number) >> 8) & 1;
        this.colorAddress = (this.colorAddress + 1) & 0x1ff;
        return value;
      }
      default:
        return 0;
    }
  }

  /** Write one of the colour encoder's eight addresses. */
  writeVce(offset: number, value: number): void {
    const byte = value & 0xff;
    switch (offset & 7) {
      case 2:
        this.colorAddress = (this.colorAddress & 0x100) | byte;
        return;
      case 3:
        this.colorAddress = (this.colorAddress & 0x0ff) | ((byte & 1) << 8);
        return;
      case 4:
        this.palette[this.colorAddress & 0x1ff] =
          ((this.palette[this.colorAddress & 0x1ff] as number) & 0x100) | byte;
        return;
      case 5:
        // The high half is one bit, and writing it steps the address — which is
        // what makes a palette upload a plain run of byte pairs.
        this.palette[this.colorAddress & 0x1ff] =
          ((this.palette[this.colorAddress & 0x1ff] as number) & 0x0ff) | ((byte & 1) << 8);
        this.colorAddress = (this.colorAddress + 1) & 0x1ff;
        return;
      default:
        return;
    }
  }

  /** What the address port steps by after each access. */
  private get increment(): number {
    return INCREMENT[((this.regs[REG.CR] as number) >> 11) & 3] as number;
  }

  /** Finish a register write: the two that act rather than store. */
  private afterRegister(high: boolean): void {
    // Video RAM is written when the *high* byte arrives, because that is when a
    // whole word exists — a runtime that wrote only the low half would leave the
    // other one as it was, which is what the hardware does too.
    if (this.selected === REG.VRR && high) {
      this.vram[(this.regs[REG.MAWR] as number) & 0x7fff] = this.regs[REG.VRR] as number;
      this.regs[REG.MAWR] = ((this.regs[REG.MAWR] as number) + this.increment) & 0xffff;
      return;
    }
    if (this.selected === REG.DVSSR) this.satPending = true;
    if (this.selected === REG.LENR && high) this.blockCopy();
  }

  /** A read through the data port, stepping the read address on the high half. */
  private readData(high = false): number {
    const word = this.vram[(this.regs[REG.MARR] as number) & 0x7fff] as number;
    if (high) this.regs[REG.MARR] = ((this.regs[REG.MARR] as number) + this.increment) & 0xffff;
    return word;
  }

  /** The VRAM-to-VRAM transfer `LENR` starts, which nothing here emits yet. */
  private blockCopy(): void {
    const control = this.regs[REG.DCR] as number;
    let source = this.regs[REG.SOUR] as number;
    let dest = this.regs[REG.DESR] as number;
    const count = ((this.regs[REG.LENR] as number) + 1) & 0xffff;
    for (let index = 0; index < count; index += 1) {
      this.vram[dest & 0x7fff] = this.vram[source & 0x7fff] as number;
      source += (control & 0x04) !== 0 ? -1 : 1;
      dest += (control & 0x08) !== 0 ? -1 : 1;
    }
    if ((control & 0x02) !== 0) this.raise(0x10);
  }

  /** Raise a status bit, and the interrupt line if `CR` allows it. */
  private raise(bit: number): void {
    this.status |= bit;
    // `CR`'s low four bits are the four enables, in the same order as the status
    // bits they answer for: collision, overflow, raster, vertical blank.
    const enables = (this.regs[REG.CR] as number) & 0x0f;
    const allowed =
      ((bit & 0x01) !== 0 && (enables & 0x01) !== 0) ||
      ((bit & 0x02) !== 0 && (enables & 0x02) !== 0) ||
      ((bit & 0x04) !== 0 && (enables & 0x04) !== 0) ||
      ((bit & 0x20) !== 0 && (enables & 0x08) !== 0);
    if (allowed) this.irq = true;
  }

  // --- timing ----------------------------------------------------------------

  /** Advance the raster by `master` master clocks, rendering as lines complete. */
  step(master: number): void {
    this.clocks += master;
    while (this.clocks >= MASTER_PER_LINE) {
      this.clocks -= MASTER_PER_LINE;
      this.endLine();
    }
  }

  private endLine(): void {
    const active = this.activeLines;
    if (this.line < active) this.renderLine(this.line);
    // The raster compare fires on the line `RCR` names, counted from the first
    // active one plus the hardware's own 64-line bias.
    const compare = ((this.regs[REG.RCR] as number) & 0x3ff) - 64;
    if (compare === this.line) this.raise(0x04);

    this.line += 1;
    if (this.line === active) {
      // The sprite table is fetched at the top of the blanking interval, which is
      // why a table written this frame takes effect on the next one.
      if (this.satPending || ((this.regs[REG.DCR] as number) & 0x10) !== 0) {
        const source = (this.regs[REG.DVSSR] as number) & 0x7fff;
        for (let index = 0; index < 256; index += 1) {
          this.sat[index] = this.vram[(source + index) & 0x7fff] as number;
        }
        this.satPending = false;
        this.raise(0x08);
      }
      this.raise(0x20);
    }
    if (this.line >= LINES_PER_FRAME) {
      this.line = 0;
      this.frames += 1;
      this.byrLatch = this.regs[REG.BYR] as number;
    }
  }

  /** Active display lines, as `VDW` programs them, clamped to the framebuffer. */
  private get activeLines(): number {
    const programmed = ((this.regs[REG.VDW] as number) & 0x1ff) + 1;
    return Math.min(programmed, SCREEN_HEIGHT);
  }

  /** Active display columns, as `HDR` programs them, clamped to the framebuffer. */
  private get activeColumns(): number {
    const programmed = (((this.regs[REG.HDR] as number) & 0x3f) + 1) * 8;
    return Math.min(programmed, SCREEN_WIDTH);
  }

  /** The background map's size in cells, which `MWR` selects. */
  private get mapSize(): { width: number; height: number } {
    const mwr = this.regs[REG.MWR] as number;
    const width = [32, 64, 128, 128][(mwr >> 4) & 3] as number;
    const height = (mwr & 0x40) !== 0 ? 64 : 32;
    return { width, height };
  }

  // --- rendering -------------------------------------------------------------

  private renderLine(y: number): void {
    const cr = this.regs[REG.CR] as number;
    const backdrop = expandColor(this.palette[0] as number);
    const columns = this.activeColumns;
    // The index each pixel took, so the sprite pass can tell "the background
    // drew something" from "the background was transparent" — which is what
    // decides a low-priority sprite.
    const under = new Uint8Array(SCREEN_WIDTH);

    this.lineScrollX = (this.regs[REG.BXR] as number) & 0x3ff;
    this.lineScrollY = (this.byrLatch + y) & 0x1ff;

    const row = y * SCREEN_WIDTH * 4;
    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      const at = row + x * 4;
      this.framebuffer[at] = backdrop[0];
      this.framebuffer[at + 1] = backdrop[1];
      this.framebuffer[at + 2] = backdrop[2];
      this.framebuffer[at + 3] = 0xff;
    }
    if ((cr & 0x80) !== 0) this.renderBackground(y, columns, under);
    if ((cr & 0x40) !== 0) this.renderSprites(y, columns, under);
  }

  private renderBackground(y: number, columns: number, under: Uint8Array): void {
    const { width, height } = this.mapSize;
    const mapRow = Math.floor(this.lineScrollY / 8) % height;
    const withinRow = this.lineScrollY & 7;
    const row = y * SCREEN_WIDTH * 4;

    for (let x = 0; x < columns; x += 1) {
      const scrolled = (this.lineScrollX + x) & 0x3ff;
      const mapCol = Math.floor(scrolled / 8) % width;
      const withinCol = scrolled & 7;
      const entry = this.vram[(mapRow * width + mapCol) & 0x7fff] as number;
      const character = entry & 0x0fff;
      const palette = (entry >> 12) & 0x0f;
      // A character is sixteen words: eight of planes 0 and 1, then eight of 2
      // and 3, one word per row with the low byte the lower-numbered plane.
      const base = (character * 16) & 0x7fff;
      const low = this.vram[(base + withinRow) & 0x7fff] as number;
      const high = this.vram[(base + 8 + withinRow) & 0x7fff] as number;
      const bit = 7 - withinCol;
      const index =
        ((low >> bit) & 1) |
        (((low >> (8 + bit)) & 1) << 1) |
        (((high >> bit) & 1) << 2) |
        (((high >> (8 + bit)) & 1) << 3);
      if (index === 0) continue; // colour zero shows the backdrop, whatever the palette
      under[x] = 1;
      const colour = expandColor(this.palette[(palette * 16 + index) & 0xff] as number);
      const at = row + x * 4;
      this.framebuffer[at] = colour[0];
      this.framebuffer[at + 1] = colour[1];
      this.framebuffer[at + 2] = colour[2];
    }
  }

  private renderSprites(y: number, columns: number, under: Uint8Array): void {
    const row = y * SCREEN_WIDTH * 4;
    let drawn = 0;
    for (let index = 0; index < SPRITES && drawn < SPRITES_PER_LINE; index += 1) {
      const word = index * 4;
      // Both positions carry a hardware bias: 64 lines and 32 pixels, which is
      // where the blanking interval ends.
      const top = ((this.sat[word] as number) & 0x3ff) - 64;
      const left = ((this.sat[word + 1] as number) & 0x3ff) - 32;
      const pattern = (this.sat[word + 2] as number) >> 1;
      const attr = this.sat[word + 3] as number;
      const wide = (attr & 0x0100) !== 0 ? 32 : 16;
      const tall = [16, 32, 64, 64][(attr >> 12) & 3] as number;
      if (y < top || y >= top + tall) continue;
      drawn += 1;
      if (left >= columns || left + wide <= 0) continue;

      const palette = attr & 0x0f;
      const front = (attr & 0x80) !== 0;
      const flipX = (attr & 0x0800) !== 0;
      const flipY = (attr & 0x8000) !== 0;
      const withinY = flipY ? tall - 1 - (y - top) : y - top;

      // A sprite bigger than 16x16 is several 16x16 patterns, and *which* ones is
      // decided by masking the pattern number rather than by a list: bit 0 is the
      // horizontal cell and bits 1-2 the vertical one, so a 32-wide sprite must
      // start on an even pattern and a 64-tall one on a multiple of eight. The
      // hardware masks those bits rather than honouring them, which is why this
      // clears them instead of trusting the table.
      const acrossCells = wide / 16;
      const downCells = tall / 16;
      let code = pattern;
      if (acrossCells > 1) code &= ~1;
      if (downCells > 1) code &= ~((downCells - 1) << 1);
      const cellY = Math.floor(withinY / 16);

      for (let dx = 0; dx < wide; dx += 1) {
        const x = left + dx;
        if (x < 0 || x >= columns) continue;
        if (!front && under[x] !== 0) continue;
        const withinX = flipX ? wide - 1 - dx : dx;
        const cell = code | (acrossCells > 1 ? Math.floor(withinX / 16) : 0) | (cellY << 1);
        // Sixty-four words a pattern: sixteen rows of plane 0, then planes 1, 2
        // and 3 — so one row of one plane is a whole word, and bit 15 is its
        // leftmost pixel.
        const line = (cell * 64 + (withinY & 15)) & 0x7fff;
        const bit = 15 - (withinX & 15);
        const value =
          (((this.vram[line] as number) >> bit) & 1) |
          ((((this.vram[(line + 16) & 0x7fff] as number) >> bit) & 1) << 1) |
          ((((this.vram[(line + 32) & 0x7fff] as number) >> bit) & 1) << 2) |
          ((((this.vram[(line + 48) & 0x7fff] as number) >> bit) & 1) << 3);
        if (value === 0) continue; // an object's colour zero is transparency
        const colour = expandColor(this.palette[(256 + palette * 16 + value) & 0x1ff] as number);
        const at = row + x * 4;
        this.framebuffer[at] = colour[0];
        this.framebuffer[at + 1] = colour[1];
        this.framebuffer[at + 2] = colour[2];
      }
    }
    if (drawn >= SPRITES_PER_LINE) this.raise(0x02);
  }
}
