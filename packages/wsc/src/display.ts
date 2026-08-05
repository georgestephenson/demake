/**
 * The WonderSwan Color's display controller.
 *
 * Two background layers, 128 objects and sixteen sixteen-colour palettes, all of
 * them reading the console's own internal RAM — which is the first thing about
 * this hardware that is not like anything else in the set. There is no video
 * memory: the screen maps, the tile bank, the object table and palette RAM are
 * *addresses*, in the same 64 KiB the game's variables are in, so a picture is
 * written with an ordinary store and nothing is ever uploaded through a port.
 *
 * Three more of its facts reach the backend above it:
 *
 *   - **The second layer is a layer, not a window.** `SCR2` scrolls
 *     independently of `SCR1` and draws in front of it, so a scrolling scene's
 *     HUD gets a plane of its own — the Game Boy Advance's arrangement, on a
 *     console with a tenth of its hardware, and the reason this backend has no
 *     sprite HUD and no second decimal renderer.
 *   - **Colour zero is transparent on both layers.** A cell whose pixels are all
 *     zero shows whatever is behind it, and behind everything is the backdrop
 *     colour port `$01` names — which is what makes a HUD plane over a picture
 *     work at all, and is the Mega Drive's arrangement reached by different
 *     hardware.
 *   - **A cell carries its own palette.** Four bits in the map entry, so there is
 *     no attribute table, no 16×16 block to reason about, and a caption's cell
 *     simply names the font's palette. The PC Engine's arrangement, one console
 *     over.
 *
 * Scope is what a demade cartridge uses. The two window units, the mono and
 * 2bpp display modes, the "planar" tile format and the LCD's segment icons are
 * **absent rather than half-implemented**: their registers are stored and inert,
 * and a renderer that answered plausibly for hardware nothing drives is a
 * renderer nobody is checking.
 *
 * Sources: WSdev wiki — Display controller, Tiles, Sprites and Palettes.
 */

/** The visible picture, in pixels. */
export const SCREEN_WIDTH = 224;
export const SCREEN_HEIGHT = 144;

/** Processor cycles in one scanline. */
export const CYCLES_PER_LINE = 256;

/**
 * Scanlines in a frame, counting the blanking ones.
 *
 * The default `VTOTAL` is 158, and the frame is one line longer than it — so at
 * the processor's 3.072 MHz a frame is 40704 cycles and the display runs at
 * 75.47 Hz, which is the figure the hardware is documented at.
 */
export const LINES_PER_FRAME = 159;

/** Where the first blanking line is: the picture is lines 0 to 143. */
export const VBLANK_LINE = SCREEN_HEIGHT;

/** Objects the table holds, and the most the chip draws on one scanline. */
export const MAX_SPRITES = 128;
export const SPRITES_PER_LINE = 32;

/** Ports this controller answers, by number. */
export const PORT = {
  /** Which layers are drawn. */
  DISP_CTRL: 0x00,
  /** The colour behind everything, as `palette << 4 | index`. */
  BACK_COLOR: 0x01,
  /** The line being drawn, which is how a cartridge with no interrupt waits. */
  LINE_CUR: 0x02,
  LINE_CMP: 0x03,
  /** The object table's address, in units of 512 bytes. */
  SPR_BASE: 0x04,
  SPR_FIRST: 0x05,
  SPR_COUNT: 0x06,
  /** Both screen maps' addresses, a nibble each, in units of 2 KiB. */
  MAP_BASE: 0x07,
  SCR1_X: 0x10,
  SCR1_Y: 0x11,
  SCR2_X: 0x12,
  SCR2_Y: 0x13,
  LCD_CTRL: 0x14,
  LCD_ICON: 0x15,
  VTOTAL: 0x16,
  VSYNC: 0x17,
  /** Colour mode, tile depth and tile layout. */
  DISP_MODE: 0x60,
} as const;

/** Where the tile bank and palette RAM are, which the hardware fixes. */
export const TILE_BASE = 0x4000;
export const PALETTE_BASE = 0xfe00;

/** Expand a four-bit colour channel the way the hardware's ladder does. */
export function expandChannel(value: number): number {
  return (value & 0xf) * 0x11;
}

/** The display controller, over the console's internal RAM. */
export class Display {
  /** The ports, indexed by number; only the ones above mean anything. */
  private readonly regs = new Uint8Array(0x100);

  /** The line being drawn, 0 to {@link LINES_PER_FRAME} − 1. */
  line = 0;
  /** Frames completed since power-on — the harness's clock. */
  frames = 0;
  /** True while the display is in its blanking interval. */
  get vblank(): boolean {
    return this.line >= VBLANK_LINE;
  }

  /** The picture, as RGBA. */
  readonly framebuffer = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);

  /** Cycles not yet accounted to a scanline. */
  private cycles = 0;

  /** Per-pixel scratch for one scanline: the colour word, or −1 for nothing. */
  private readonly scr1 = new Int32Array(SCREEN_WIDTH);
  private readonly scr2 = new Int32Array(SCREEN_WIDTH);
  private readonly sprite = new Int32Array(SCREEN_WIDTH);
  private readonly spriteFront = new Uint8Array(SCREEN_WIDTH);

  constructor(private readonly ram: Uint8Array) {
    this.regs[PORT.VTOTAL] = LINES_PER_FRAME - 1;
  }

  read(port: number): number {
    if (port === PORT.LINE_CUR) return this.line & 0xff;
    return this.regs[port & 0xff] as number;
  }

  write(port: number, value: number): void {
    if (port === PORT.LINE_CUR) return; // the line counter is the chip's
    this.regs[port & 0xff] = value & 0xff;
  }

  /** Whether this port is one of ours. */
  static owns(port: number): boolean {
    return port <= 0x17 || port === PORT.DISP_MODE;
  }

  /**
   * Advance by `cycles` processor clocks, drawing whatever lines that covers.
   *
   * A line is drawn when the counter leaves it, so what a scene shows is the
   * register state at the end of that line — which is what a chip that fetches
   * as it scans does, and what makes a scroll register written in the blanking
   * interval take effect on the whole next frame rather than half of one.
   */
  step(cycles: number): void {
    this.cycles += cycles;
    while (this.cycles >= CYCLES_PER_LINE) {
      this.cycles -= CYCLES_PER_LINE;
      if (this.line < SCREEN_HEIGHT) this.renderLine(this.line);
      this.line += 1;
      if (this.line >= LINES_PER_FRAME) {
        this.line = 0;
        this.frames += 1;
      }
    }
  }

  // --- rendering -------------------------------------------------------------

  /** One palette entry, as a packed `0x00RRGGBB`. */
  private color(palette: number, index: number): number {
    const at = PALETTE_BASE + palette * 32 + index * 2;
    const low = this.ram[at] as number;
    const high = this.ram[(at + 1) & 0xffff] as number;
    return (expandChannel(high) << 16) | (expandChannel(low >> 4) << 8) | expandChannel(low & 0x0f);
  }

  /** The four-bit pixel at (`x`, `y`) of a tile, honouring its flips. */
  private tilePixel(tile: number, x: number, y: number, xflip: boolean, yflip: boolean): number {
    const column = xflip ? 7 - x : x;
    const row = yflip ? 7 - y : y;
    const byte = this.ram[(TILE_BASE + tile * 32 + row * 4 + (column >> 1)) & 0xffff] as number;
    // Packed 4bpp: two pixels a byte, and the left one is the high nibble.
    return (column & 1) === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
  }

  /**
   * One background layer's contribution to a scanline.
   *
   * The map is 32×32 cells and the screen is 28 by 18, so both axes wrap inside
   * the map and a scrolling scene paints its leading edge into cells nobody is
   * looking at. Both wraps are powers of two, which is what makes the cell
   * address two masks and a shift.
   */
  private renderLayer(out: Int32Array, base: number, scrollX: number, scrollY: number, y: number) {
    const sourceY = (y + scrollY) & 0xff;
    const row = (sourceY >> 3) & 31;
    const pixelY = sourceY & 7;
    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      const sourceX = (x + scrollX) & 0xff;
      const entry = base + ((row * 32 + ((sourceX >> 3) & 31)) << 1);
      const word = (this.ram[entry] as number) | ((this.ram[(entry + 1) & 0xffff] as number) << 8);
      const index = this.tilePixel(
        word & 0x1ff,
        sourceX & 7,
        pixelY,
        (word & 0x4000) !== 0,
        (word & 0x8000) !== 0,
      );
      out[x] = index === 0 ? -1 : this.color((word >> 9) & 0x0f, index);
    }
  }

  /**
   * The objects covering a scanline, front to back.
   *
   * Entry order is priority: the first object that covers a pixel keeps it, so
   * the scan stops writing a pixel once something has. The per-line budget is
   * thirty-two, which is four times what the 8-bit consoles in this set allow
   * and is counted here for the same reason theirs is — an object the hardware
   * would drop has to go missing in the model too.
   */
  private renderSprites(y: number): void {
    this.sprite.fill(-1);
    this.spriteFront.fill(0);
    const table = ((this.regs[PORT.SPR_BASE] as number) & 0x3f) << 9;
    const first = (this.regs[PORT.SPR_FIRST] as number) & 0x7f;
    const count = Math.min((this.regs[PORT.SPR_COUNT] as number) & 0xff, MAX_SPRITES);
    let drawn = 0;
    for (let index = 0; index < count && drawn < SPRITES_PER_LINE; index += 1) {
      const at = (table + (((first + index) & 0x7f) << 2)) & 0xffff;
      const word = (this.ram[at] as number) | ((this.ram[(at + 1) & 0xffff] as number) << 8);
      const spriteY = this.ram[(at + 2) & 0xffff] as number;
      const spriteX = this.ram[(at + 3) & 0xffff] as number;
      const row = y - spriteY;
      if (row < 0 || row > 7) continue;
      drawn += 1;
      const palette = 8 + ((word >> 9) & 7);
      const front = (word & 0x1000) !== 0;
      for (let column = 0; column < 8; column += 1) {
        const x = spriteX + column;
        if (x < 0 || x >= SCREEN_WIDTH) continue;
        if (this.sprite[x] !== -1) continue;
        const pixel = this.tilePixel(
          word & 0x1ff,
          column,
          row,
          (word & 0x4000) !== 0,
          (word & 0x8000) !== 0,
        );
        if (pixel === 0) continue;
        this.sprite[x] = this.color(palette, pixel);
        this.spriteFront[x] = front ? 1 : 0;
      }
    }
  }

  private renderLine(y: number): void {
    const control = this.regs[PORT.DISP_CTRL] as number;
    const lcdOn = ((this.regs[PORT.LCD_CTRL] as number) & 1) !== 0;
    const backdropByte = this.regs[PORT.BACK_COLOR] as number;
    const backdrop = lcdOn ? this.color((backdropByte >> 4) & 0x0f, backdropByte & 0x0f) : 0;

    const bases = this.regs[PORT.MAP_BASE] as number;
    if (lcdOn && (control & 0x01) !== 0) {
      this.renderLayer(
        this.scr1,
        (bases & 0x0f) << 11,
        this.regs[PORT.SCR1_X] as number,
        this.regs[PORT.SCR1_Y] as number,
        y,
      );
    } else this.scr1.fill(-1);
    if (lcdOn && (control & 0x02) !== 0) {
      this.renderLayer(
        this.scr2,
        ((bases >> 4) & 0x0f) << 11,
        this.regs[PORT.SCR2_X] as number,
        this.regs[PORT.SCR2_Y] as number,
        y,
      );
    } else this.scr2.fill(-1);
    if (lcdOn && (control & 0x04) !== 0) this.renderSprites(y);
    else this.sprite.fill(-1);

    // Back to front: the first layer, objects the hardware puts behind the
    // second layer, the second layer, then the objects in front of it.
    let at = y * SCREEN_WIDTH * 4;
    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      let color = backdrop;
      if (this.scr1[x] !== -1) color = this.scr1[x] as number;
      if (this.sprite[x] !== -1 && this.spriteFront[x] === 0) color = this.sprite[x] as number;
      if (this.scr2[x] !== -1) color = this.scr2[x] as number;
      if (this.sprite[x] !== -1 && this.spriteFront[x] === 1) color = this.sprite[x] as number;
      this.framebuffer[at] = (color >> 16) & 0xff;
      this.framebuffer[at + 1] = (color >> 8) & 0xff;
      this.framebuffer[at + 2] = color & 0xff;
      this.framebuffer[at + 3] = 0xff;
      at += 4;
    }
  }
}
