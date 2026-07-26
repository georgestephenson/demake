/**
 * The Sega VDP in mode 4 — the Master System's and the Game Gear's display.
 *
 * Scope is what the generated runtime uses, which on this chip is most of it:
 * a scrolling 32×28 name table, 4bpp characters, sixty-four sprites with an
 * eight-per-line limit, two sixteen-colour palettes, and both interrupts. The
 * TMS9918 legacy modes are absent — the SG-1000's Graphics II is a different
 * renderer and doc 13 §Phase 5 keeps it a separate piece of work, not a flag on
 * this one.
 *
 * The chip is a descendant of the TMS9918 and the inheritance shows in the two
 * places that catch people out:
 *
 *   - **The name table is 28 rows tall and the screen is 24.** Vertical scroll
 *     wraps at 224 pixels, not at 192, so the four rows below the screen are a
 *     scratch area a game scrolls *through* rather than a mistake. A renderer
 *     that wraps at the screen's height shows the top of the map four rows early.
 *   - **The scroll registers move the picture, not the window.** `R8` shifts the
 *     background *right*, so the column a given screen cell reads is
 *     `(col - (R8 >> 3))`, and the fine part shifts the fetch left. Getting the
 *     sign wrong produces a picture that scrolls the correct distance in the
 *     wrong direction, which looks like a backend bug rather than a chip one.
 *
 * Two more that are this chip's own:
 *
 *   - **Sprites are always palette 1, and colour 0 is transparent in both.** So
 *     the sprite bank's fit gets fifteen colours and the backdrop is an index
 *     into the *sprite* palette even though it fills the border.
 *   - **A Game Gear is a Master System with a smaller window.** The VDP renders
 *     the whole 256×192 frame and the LCD shows the middle 160×144. Rendering
 *     only the window would be cheaper and would put every sprite in the wrong
 *     place, because the coordinates the hardware works in are the big frame's.
 *
 * Sources: SMS Power! — VDP Documentation
 * (https://www.smspower.org/Development/VDPRegisters,
 * .../TileMapAddress, .../SpriteAttributeTable) and the TMS9918A datasheet for
 * the parts of the register file mode 4 inherited.
 */

/** The frame the VDP renders, which is what a Master System displays. */
export const FRAME_WIDTH = 256;
export const FRAME_HEIGHT = 192;

/** The window a Game Gear's LCD shows, and where it sits in the frame. */
export const GG_WIDTH = 160;
export const GG_HEIGHT = 144;
export const GG_LEFT = (FRAME_WIDTH - GG_WIDTH) / 2;
export const GG_TOP = (FRAME_HEIGHT - GG_HEIGHT) / 2;

/** Scanlines in an NTSC frame, and the CPU cycles each one lasts. */
export const LINES_PER_FRAME = 262;
export const CYCLES_PER_LINE = 228;

/** Cells the name table holds. It is taller than the screen by four rows. */
export const MAP_COLUMNS = 32;
export const MAP_ROWS = 28;

/** Which machine's colour RAM this is: one byte a colour, or two. */
export type VdpVariant = "sms" | "gg";

/** Sprites the hardware will draw on one line before it gives up. */
const SPRITES_PER_LINE = 8;

/** The Sega VDP's registers, memories and renderer. */
export class Vdp {
  readonly vram = new Uint8Array(0x4000);
  /** 32 bytes on a Master System, 64 on a Game Gear. */
  readonly cram: Uint8Array;
  readonly registers = new Uint8Array(16);

  /** The picture, as RGBA, at the frame's full size. */
  readonly framebuffer = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);
  /**
   * The palette index behind every pixel.
   *
   * Kept alongside the colours for the reason the NES core keeps one: a test
   * that asks "what did the hardware put here" wants the index, and deriving it
   * back out of RGB is a guess whenever two entries hold the same colour.
   */
  readonly indices = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);

  /** The scanline being generated, and how far into it the CPU has run. */
  line = 0;
  private lineCycles = 0;
  /** Frames completed since power-on — the harness's clock. */
  frames = 0;

  /** Whether the frame and line interrupt lines are asserted. */
  frameIrq = false;
  lineIrq = false;

  /** The control port's two-byte protocol, mid-sequence. */
  private latched = false;
  private latch = 0;
  private address = 0;
  private code = 0;
  /** VRAM reads come from a buffer the previous read filled. */
  private readBuffer = 0;

  /** The line-interrupt counter, reloaded from `R10`. */
  private lineCounter = 0;

  private spriteOverflow = false;
  private spriteCollision = false;

  /**
   * The window a Game Gear's LCD shows, kept between calls.
   *
   * One buffer rather than a fresh one per frame, because a caller that holds
   * the reference — the web app's player does, so its frame loop is a `putImage`
   * and nothing else — would otherwise be drawing whatever the first call
   * happened to return for ever.
   */
  private readonly window: Uint8ClampedArray;

  constructor(readonly variant: VdpVariant = "sms") {
    this.cram = new Uint8Array(variant === "gg" ? 64 : 32);
    this.framebuffer.fill(0xff);
    this.window =
      variant === "gg" ? new Uint8ClampedArray(GG_WIDTH * GG_HEIGHT * 4) : this.framebuffer;
  }

  // --- register decoding -----------------------------------------------------

  /** Where the name table starts. `$FF` in `R2` puts it at `$3800`. */
  private get nameTableBase(): number {
    return ((this.registers[2] as number) & 0x0e) << 10;
  }

  /** Where the sprite attribute table starts. `$FF` in `R5` puts it at `$3F00`. */
  private get spriteTableBase(): number {
    return ((this.registers[5] as number) & 0x7e) << 7;
  }

  /** Which half of VRAM sprite characters come from. */
  private get spritePatternBase(): number {
    return ((this.registers[6] as number) & 0x04) << 11;
  }

  private get displayEnabled(): boolean {
    return ((this.registers[1] as number) & 0x40) !== 0;
  }

  private get frameIrqEnabled(): boolean {
    return ((this.registers[1] as number) & 0x20) !== 0;
  }

  private get lineIrqEnabled(): boolean {
    return ((this.registers[0] as number) & 0x10) !== 0;
  }

  /** Tall sprites: one character above another, and the tile's low bit ignored. */
  private get tallSprites(): boolean {
    return ((this.registers[1] as number) & 0x02) !== 0;
  }

  /** Whether the interrupt line is asserted at all. */
  get irq(): boolean {
    return (this.frameIrq && this.frameIrqEnabled) || (this.lineIrq && this.lineIrqEnabled);
  }

  // --- ports -----------------------------------------------------------------

  /**
   * Read the status byte, which is also how the two interrupts are acknowledged.
   *
   * Reading clears the frame flag, the sprite flags *and* the control port's
   * half-written state — the last of which is why an interrupt handler that
   * reads the status in the middle of a two-byte control write corrupts it.
   */
  readControl(): number {
    const status =
      (this.frameIrq ? 0x80 : 0) |
      (this.spriteOverflow ? 0x40 : 0) |
      (this.spriteCollision ? 0x20 : 0);
    this.frameIrq = false;
    this.lineIrq = false;
    this.spriteOverflow = false;
    this.spriteCollision = false;
    this.latched = false;
    return status | 0x1f;
  }

  /** The two-byte control protocol: a low byte, then a command and a high byte. */
  writeControl(value: number): void {
    const byte = value & 0xff;
    if (!this.latched) {
      this.latch = byte;
      this.latched = true;
      // The low byte of the address takes effect immediately, before the command
      // arrives — which is what makes a `ld (hl),a` pair to this port work.
      this.address = (this.address & 0x3f00) | byte;
      return;
    }
    this.latched = false;
    this.code = (byte >> 6) & 3;
    this.address = ((byte & 0x3f) << 8) | this.latch;
    if (this.code === 0) {
      // A read command pre-fetches the byte at the address it just set.
      this.readBuffer = this.vram[this.address] as number;
      this.address = (this.address + 1) & 0x3fff;
      return;
    }
    // A register write carries the value in the byte that was latched first and
    // the register number in the low nibble of the command byte.
    if (this.code === 2) this.writeRegister(byte & 0x0f, this.latch);
  }

  /** Set one register. */
  writeRegister(register: number, value: number): void {
    this.registers[register & 0x0f] = value & 0xff;
  }

  readData(): number {
    const value = this.readBuffer;
    this.readBuffer = this.vram[this.address] as number;
    this.address = (this.address + 1) & 0x3fff;
    this.latched = false;
    return value;
  }

  /**
   * Write through the data port, to VRAM or to colour RAM.
   *
   * The address counter wraps inside VRAM's fourteen bits even for a colour
   * write, and the colour write masks it down to the palette's size separately —
   * so a game that uploads more colours than there are wraps onto the first,
   * exactly as the hardware does.
   */
  writeData(value: number): void {
    const byte = value & 0xff;
    if (this.code === 3) this.cram[this.address % this.cram.length] = byte;
    else this.vram[this.address] = byte;
    this.readBuffer = byte;
    this.address = (this.address + 1) & 0x3fff;
    this.latched = false;
  }

  /** The V counter, which a raster effect polls. */
  get vCounter(): number {
    // NTSC's counter repeats $DA–$FF after reaching $DA, so a 262-line frame
    // reports 256 distinct values.
    return this.line <= 0xda ? this.line : this.line - 0x06;
  }

  /** The H counter, latched. Nothing the backend emits reads it. */
  get hCounter(): number {
    return (this.lineCycles >> 1) & 0xff;
  }

  // --- timing ----------------------------------------------------------------

  /**
   * Advance by CPU cycles, rendering each line as it completes.
   *
   * A line is rendered whole, at its end, rather than pixel by pixel: the
   * runtime does its VDP work inside the blanking window, so nothing it emits
   * can observe the difference — and a mid-line raster split, which could, is
   * caught by the libretro E2E rather than here.
   */
  step(cycles: number): void {
    this.lineCycles += cycles;
    while (this.lineCycles >= CYCLES_PER_LINE) {
      this.lineCycles -= CYCLES_PER_LINE;
      this.endLine();
    }
  }

  private endLine(): void {
    if (this.line < FRAME_HEIGHT) this.renderLine(this.line);

    // The line counter runs across the active display and one line past it,
    // reloading from R10 whenever it underflows.
    if (this.line <= FRAME_HEIGHT) {
      if (this.lineCounter === 0) {
        this.lineCounter = this.registers[10] as number;
        this.lineIrq = true;
      } else {
        this.lineCounter -= 1;
      }
    } else {
      this.lineCounter = this.registers[10] as number;
    }

    if (this.line === FRAME_HEIGHT) this.frameIrq = true;

    this.line += 1;
    if (this.line >= LINES_PER_FRAME) {
      this.line = 0;
      this.frames += 1;
    }
  }

  // --- rendering -------------------------------------------------------------

  /** The colour a palette entry holds, as RGBA, through the console's own DAC. */
  private colour(entry: number): [number, number, number] {
    if (this.variant === "gg") {
      const at = (entry & 0x1f) * 2;
      const low = this.cram[at] as number;
      const high = this.cram[at + 1] as number;
      // ----BBBBGGGGRRRR, and four bits expand by replication: v * 17.
      return [(low & 0x0f) * 17, ((low >> 4) & 0x0f) * 17, (high & 0x0f) * 17];
    }
    const byte = this.cram[entry & 0x1f] as number;
    // --BBGGRR, and two bits expand by replication: v * 85.
    return [(byte & 3) * 85, ((byte >> 2) & 3) * 85, ((byte >> 4) & 3) * 85];
  }

  /** One scanline of background and sprites, into `indices` and the framebuffer. */
  private renderLine(line: number): void {
    const base = line * FRAME_WIDTH;
    // The backdrop is an index into the *sprite* palette, even though it fills
    // the border as well as the unwritten cells.
    const backdrop = 16 + ((this.registers[7] as number) & 0x0f);
    this.indices.fill(backdrop, base, base + FRAME_WIDTH);

    if (this.displayEnabled) {
      const priority = this.renderBackground(line, base);
      this.renderSprites(line, base, priority);
      // Masking column zero happens last: it covers whatever was drawn there.
      if (((this.registers[0] as number) & 0x20) !== 0) {
        this.indices.fill(backdrop, base, base + 8);
      }
    }

    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const at = base + x;
      const [r, g, b] = this.colour(this.indices[at] as number);
      const pixel = at * 4;
      this.framebuffer[pixel] = r;
      this.framebuffer[pixel + 1] = g;
      this.framebuffer[pixel + 2] = b;
      this.framebuffer[pixel + 3] = 0xff;
    }
  }

  /**
   * Draw the background, and report which pixels want to be in front of sprites.
   *
   * A cell's priority bit means "this cell's non-zero pixels cover sprites", so
   * the answer is per pixel rather than per cell — a priority cell's transparent
   * pixels still let a sprite through.
   */
  private renderBackground(line: number, base: number): Uint8Array {
    const priority = this.priorityRow;
    priority.fill(0);

    const scrollX = this.registers[8] as number;
    const scrollY = this.registers[9] as number;
    const lockRows = ((this.registers[0] as number) & 0x40) !== 0;
    const lockColumns = ((this.registers[0] as number) & 0x80) !== 0;
    const nameBase = this.nameTableBase;

    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const column = x >> 3;
      // The top two rows can be held still while the rest scrolls sideways, which
      // is how a scrolling game pins a status bar without sprites.
      const shiftX = lockRows && line < 16 ? 0 : scrollX;
      // The right eight columns can be held still while the rest scrolls up.
      const shiftY = lockColumns && column >= 24 ? 0 : scrollY;

      const sourceX = (x - shiftX) & 0xff;
      const sourceY = (line + shiftY) % (MAP_ROWS * 8);
      const cell = nameBase + ((sourceY >> 3) * MAP_COLUMNS + (sourceX >> 3)) * 2;
      const low = this.vram[cell] as number;
      const high = this.vram[cell + 1] as number;
      const tile = low | ((high & 1) << 8);
      const flipX = (high & 0x02) !== 0;
      const flipY = (high & 0x04) !== 0;
      const palette = (high & 0x08) !== 0 ? 16 : 0;
      const inFront = (high & 0x10) !== 0;

      const row = flipY ? 7 - (sourceY & 7) : sourceY & 7;
      const bit = flipX ? sourceX & 7 : 7 - (sourceX & 7);
      const pixel = this.readTilePixel(tile * 32 + row * 4, bit);
      if (pixel !== 0) {
        this.indices[base + x] = palette + pixel;
        // Only where the cell is opaque: a priority cell's colour-zero pixels
        // still let a sprite through.
        if (inFront) priority[x] = 1;
      }
    }
    return priority;
  }

  private readonly priorityRow = new Uint8Array(FRAME_WIDTH);
  private readonly spriteRow = new Uint8Array(FRAME_WIDTH);

  /**
   * Read one 4bpp pixel out of a character.
   *
   * The four bitplanes are interleaved by *row*, not by tile: four bytes carry
   * one row's worth of all four planes. That is the format the image engine's
   * `packPlanar` produces for this family, and the two have to agree byte for
   * byte or a demade picture arrives as noise.
   */
  private readTilePixel(rowAddress: number, bit: number): number {
    const mask = 1 << bit;
    return (
      (((this.vram[rowAddress] as number) & mask) !== 0 ? 1 : 0) |
      (((this.vram[rowAddress + 1] as number) & mask) !== 0 ? 2 : 0) |
      (((this.vram[rowAddress + 2] as number) & mask) !== 0 ? 4 : 0) |
      (((this.vram[rowAddress + 3] as number) & mask) !== 0 ? 8 : 0)
    );
  }

  /** Draw the sprites that cover this line, up to the hardware's limit of eight. */
  private renderSprites(line: number, base: number, priority: Uint8Array): void {
    const table = this.spriteTableBase;
    const height = this.tallSprites ? 16 : 8;
    const patterns = this.spritePatternBase;
    const shiftLeft = ((this.registers[0] as number) & 0x08) !== 0 ? 8 : 0;
    const row = this.spriteRow;
    row.fill(0);

    let drawn = 0;
    for (let index = 0; index < 64; index += 1) {
      const y = this.vram[table + index] as number;
      // $D0 ends the list, which is how a game with four objects stops the other
      // sixty from being drawn at whatever the RAM happened to hold.
      if (y === 0xd0) break;
      const top = (y + 1) & 0xff;
      const offset = line - top;
      if (offset < 0 || offset >= height) continue;
      if (drawn === SPRITES_PER_LINE) {
        this.spriteOverflow = true;
        break;
      }
      drawn += 1;

      const x = (this.vram[table + 0x80 + index * 2] as number) - shiftLeft;
      let tile = this.vram[table + 0x80 + index * 2 + 1] as number;
      if (this.tallSprites) tile &= 0xfe;
      const rowAddress = patterns + tile * 32 + offset * 4;

      for (let pixel = 0; pixel < 8; pixel += 1) {
        const screenX = x + pixel;
        if (screenX < 0 || screenX >= FRAME_WIDTH) continue;
        const value = this.readTilePixel(rowAddress, 7 - pixel);
        if (value === 0) continue;
        if (row[screenX] !== 0) {
          this.spriteCollision = true;
          continue;
        }
        row[screenX] = 1;
        // A background cell marked as in front wins, but only where it is opaque.
        if (priority[screenX] !== 0) continue;
        this.indices[base + screenX] = 16 + value;
      }
    }
  }

  /** The picture the console's screen actually shows, as RGBA. */
  view(): { width: number; height: number; pixels: Uint8ClampedArray } {
    if (this.variant !== "gg") {
      return { width: FRAME_WIDTH, height: FRAME_HEIGHT, pixels: this.framebuffer };
    }
    for (let y = 0; y < GG_HEIGHT; y += 1) {
      const from = ((y + GG_TOP) * FRAME_WIDTH + GG_LEFT) * 4;
      this.window.set(this.framebuffer.subarray(from, from + GG_WIDTH * 4), y * GG_WIDTH * 4);
    }
    return { width: GG_WIDTH, height: GG_HEIGHT, pixels: this.window };
  }
}
