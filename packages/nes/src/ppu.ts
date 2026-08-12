/**
 * The 2C02 picture processor.
 *
 * A scanline renderer, on the same terms as `@demake/dmg`'s: enough hardware to
 * run a `demake build` cartridge faithfully and nothing more. What "faithfully"
 * has to include is set by what the generated runtime actually does, and two of
 * those are load-bearing:
 *
 *   - **Eight sprites a scanline, and the ninth does not draw.** Doc 14 §Budgets
 *     has the compiler warn about this limit, so the core must enforce it or the
 *     warning would be unfalsifiable.
 *   - **A 16×16 attribute cell.** The palette of a background cell comes from a
 *     packed table shared by four cells, which is the constraint the art path is
 *     written against — a core that stored a palette per tile would make a wrong
 *     conversion look right.
 *
 * The scroll model is where it is deliberately simpler than hardware. The PPU's
 * address register doubles as its scroll position and is incremented *during*
 * rendering; this captures it once, at the pre-render line, and derives each
 * visible line's position arithmetically. The two are identical for any frame
 * whose scroll is set outside rendering, which is what a fixed-tick game does and
 * what the runtime is written to do — and a mid-frame split, which nothing here
 * emits, would be visibly wrong rather than subtly wrong.
 *
 * Sources: NESdev Wiki — PPU registers (https://www.nesdev.org/wiki/PPU_registers),
 * PPU scrolling (https://www.nesdev.org/wiki/PPU_scrolling), PPU rendering
 * (https://www.nesdev.org/wiki/PPU_rendering), PPU sprite evaluation
 * (https://www.nesdev.org/wiki/PPU_sprite_evaluation).
 */

/** Visible framebuffer size. The top and bottom eight rows are overscan. */
export const SCREEN_WIDTH = 256;
export const SCREEN_HEIGHT = 240;

/** Dots in one scanline, and lines in one frame. */
export const DOTS_PER_LINE = 341;
export const LINES_PER_FRAME = 262;

/** The line VBlank starts on, and the one that pre-fetches for the next frame. */
const VBLANK_LINE = 241;
const PRERENDER_LINE = 261;

/**
 * The 64-entry 2C02 master palette, sRGB.
 *
 * The same canonical NTSC set the `nes` console spec carries as its
 * `fixed-master` colour model, and pinned against it by `test/ppu.test.ts` — a
 * DAC model is a tested artifact here (doc 10), so the in-page player, the CLI's
 * PNG and the libretro comparison all show one palette. Duplicated rather than
 * imported for the reason `DMG_SHADES` is: this package's only dependency is
 * `@demake/chip`, and a core the browser loads should not pull the whole engine
 * in behind it.
 */
export const NES_MASTER: readonly (readonly [number, number, number])[] = (
  [
    [84, 84, 84],
    [0, 30, 116],
    [8, 16, 144],
    [48, 0, 136],
    [68, 0, 100],
    [92, 0, 48],
    [84, 4, 0],
    [60, 24, 0],
    [32, 42, 0],
    [8, 58, 0],
    [0, 64, 0],
    [0, 60, 0],
    [0, 50, 60],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [152, 150, 152],
    [8, 76, 196],
    [48, 50, 236],
    [92, 30, 228],
    [136, 20, 176],
    [160, 20, 100],
    [152, 34, 32],
    [120, 60, 0],
    [84, 90, 0],
    [40, 114, 0],
    [8, 124, 0],
    [0, 118, 40],
    [0, 102, 120],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [236, 238, 236],
    [76, 154, 236],
    [120, 124, 236],
    [176, 98, 236],
    [228, 84, 236],
    [236, 88, 180],
    [236, 106, 100],
    [212, 136, 32],
    [160, 170, 0],
    [116, 196, 0],
    [76, 208, 32],
    [56, 204, 108],
    [56, 180, 204],
    [60, 60, 60],
    [0, 0, 0],
    [0, 0, 0],
    [236, 238, 236],
    [168, 204, 236],
    [188, 188, 236],
    [212, 178, 236],
    [236, 174, 236],
    [236, 174, 212],
    [236, 180, 176],
    [228, 196, 144],
    [204, 210, 120],
    [180, 222, 120],
    [168, 226, 144],
    [152, 226, 180],
    [160, 214, 228],
    [160, 162, 160],
    [0, 0, 0],
    [0, 0, 0],
  ] as const
).map(([r, g, b]) => [r, g, b] as const);

/** How the cartridge wires the two nametables into the PPU's four addresses. */
export type Mirroring = "horizontal" | "vertical";

/** The picture processor, with the cartridge's character ROM plugged into it. */
export class Ppu {
  /** Two nametables of 1 KiB; the cartridge's wiring decides which is which. */
  readonly nametables = new Uint8Array(0x0800);
  /** Palette RAM: the universal backdrop, then four background and four sprite
   * palettes of three colours each. */
  readonly palette = new Uint8Array(0x20);
  readonly oam = new Uint8Array(0x100);

  /** One byte per pixel: the master-palette index the screen shows. */
  readonly indices = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  /** RGBA, ready for `putImageData`. */
  readonly framebuffer = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);

  /** `PPUCTRL` and `PPUMASK`, as written. */
  control = 0;
  mask = 0;
  /** `PPUSTATUS` bits 5–7: overflow, sprite 0 hit, VBlank. */
  private status = 0;
  private oamAddress = 0;

  /** The scroll/address pair, and the write toggle that alternates between them. */
  private vramAddress = 0;
  private tempAddress = 0;
  private fineX = 0;
  private latch = false;
  /** `PPUDATA` reads are delayed by one, through this. */
  private readBuffer = 0;

  /** Where in the frame the beam is. */
  private line = 0;
  private dot = 0;
  /** Frames completed since power-on — the harness's clock. */
  frames = 0;

  /** The scroll position this frame renders from, captured at the pre-render line. */
  private frameScrollX = 0;
  private frameScrollY = 0;
  private frameNametable = 0;

  /**
   * Where this frame is being drawn from, for a harness that needs to say which
   * cell of a map ended up on which cell of the screen. Observation only: the
   * renderer reads the private fields, so nothing here can change what is drawn.
   */
  get scrollX(): number {
    return this.frameScrollX;
  }
  get scrollY(): number {
    return this.frameScrollY;
  }
  get nametable(): number {
    return this.frameNametable;
  }

  /** Raised when VBlank starts and the control register asked for it. */
  nmi = false;

  /** Which pixels of the line an object has already claimed. */
  private readonly objRow = new Uint8Array(SCREEN_WIDTH);
  /** Whether the background pixel there was opaque — for sprite priority. */
  private readonly bgOpaque = new Uint8Array(SCREEN_WIDTH);

  constructor(
    private readonly chr: Uint8Array,
    /**
     * How the cartridge wires the four nametables onto two.
     *
     * Settable rather than fixed, because a board with a mapper on it decides
     * this at run time: MMC1 keeps it in the low two bits of its control
     * register. An NROM cartridge sets it once, from the header, and never
     * again — which is what it was before this could move.
     */
    public mirroring: Mirroring,
  ) {
    this.framebuffer.fill(0xff);
  }

  // --- register interface ------------------------------------------------------

  /** Read one of the eight registers, by its low three address bits. */
  readRegister(register: number): number {
    switch (register & 7) {
      case 2: {
        const value = this.status;
        // Reading the status register clears VBlank and the write toggle. Both
        // are how a ROM that polls instead of using the NMI stays in step.
        this.status &= ~0x80;
        this.latch = false;
        return value;
      }
      case 4:
        return this.oam[this.oamAddress] as number;
      case 7: {
        const at = this.vramAddress & 0x3fff;
        let value: number;
        if (at >= 0x3f00) {
          value = this.palette[this.paletteIndex(at)] as number;
        } else {
          // Reads below palette RAM are delayed by one: the register returns the
          // *previous* byte and latches this one.
          value = this.readBuffer;
          this.readBuffer = this.readVram(at);
        }
        this.vramAddress = (this.vramAddress + this.addressStep()) & 0x7fff;
        return value;
      }
      default:
        // The write-only registers return whatever was last on the bus; zero is
        // as good an answer as any and nothing generated reads them.
        return 0;
    }
  }

  /** Write one of the eight registers, by its low three address bits. */
  writeRegister(register: number, value: number): void {
    const byte = value & 0xff;
    switch (register & 7) {
      case 0:
        this.control = byte;
        // The nametable select is bits 10–11 of the address register, which is
        // why changing it changes where rendering starts.
        this.tempAddress = (this.tempAddress & ~0x0c00) | ((byte & 0x03) << 10);
        return;
      case 1:
        this.mask = byte;
        return;
      case 3:
        this.oamAddress = byte;
        return;
      case 4:
        this.oam[this.oamAddress] = byte;
        this.oamAddress = (this.oamAddress + 1) & 0xff;
        return;
      case 5:
        if (!this.latch) {
          this.tempAddress = (this.tempAddress & ~0x001f) | (byte >> 3);
          this.fineX = byte & 7;
        } else {
          this.tempAddress =
            (this.tempAddress & ~0x73e0) | ((byte & 0xf8) << 2) | ((byte & 0x07) << 12);
        }
        this.latch = !this.latch;
        return;
      case 6:
        if (!this.latch) {
          this.tempAddress = (this.tempAddress & 0x00ff) | ((byte & 0x3f) << 8);
        } else {
          this.tempAddress = (this.tempAddress & 0x7f00) | byte;
          this.vramAddress = this.tempAddress;
        }
        this.latch = !this.latch;
        return;
      case 7: {
        const at = this.vramAddress & 0x3fff;
        if (at >= 0x3f00) this.palette[this.paletteIndex(at)] = byte & 0x3f;
        else this.writeVram(at, byte);
        this.vramAddress = (this.vramAddress + this.addressStep()) & 0x7fff;
        return;
      }
      default:
        return;
    }
  }

  /** `PPUCTRL` bit 2: consecutive `PPUDATA` writes go across or down. */
  private addressStep(): number {
    return (this.control & 0x04) !== 0 ? 32 : 1;
  }

  /**
   * Which physical nametable byte an address reaches.
   *
   * The PPU addresses four 1 KiB tables and the cartridge wires them to two, so
   * this is the mirroring the iNES header declared — and the reason a scrolling
   * game has to ask for vertical mirroring when it is packed rather than when it
   * runs.
   */
  private nametableOffset(address: number): number {
    const table = (address >> 10) & 3;
    const offset = address & 0x03ff;
    const bank = this.mirroring === "vertical" ? table & 1 : (table >> 1) & 1;
    return bank * 0x0400 + offset;
  }

  private readVram(address: number): number {
    const at = address & 0x3fff;
    if (at < 0x2000) return this.chr[at] ?? 0;
    return this.nametables[this.nametableOffset(at)] as number;
  }

  private writeVram(address: number, value: number): void {
    const at = address & 0x3fff;
    // Character ROM is ROM: a cartridge with no character RAM cannot change its
    // patterns, which is exactly why the NES art path bakes them into the file.
    if (at < 0x2000) return;
    this.nametables[this.nametableOffset(at)] = value & 0xff;
  }

  /** Palette RAM's own mirroring: every fourth sprite entry is a background one. */
  private paletteIndex(address: number): number {
    const at = address & 0x1f;
    return (at & 0x13) === 0x10 ? at & 0x0f : at;
  }

  // --- timing ------------------------------------------------------------------

  /** Whether the mask register has either layer enabled. */
  private get rendering(): boolean {
    return (this.mask & 0x18) !== 0;
  }

  /**
   * Advance by `dots` PPU cycles, rendering whole lines as the beam passes them.
   *
   * A line is drawn when the beam leaves it rather than as it crosses, which is
   * what makes this a scanline renderer; nothing a demade game does can observe
   * the difference, because it changes no PPU state mid-line.
   */
  step(dots: number): void {
    this.dot += dots;
    while (this.dot >= DOTS_PER_LINE) {
      this.dot -= DOTS_PER_LINE;
      if (this.line < SCREEN_HEIGHT) this.renderLine(this.line);
      this.line += 1;
      if (this.line === VBLANK_LINE) {
        this.status |= 0x80;
        if ((this.control & 0x80) !== 0) this.nmi = true;
        this.frames += 1;
        this.present();
      } else if (this.line === PRERENDER_LINE) {
        // VBlank, sprite 0 and overflow all clear here, and the address register
        // is reloaded from the latch: this is the moment a scroll written during
        // VBlank takes effect.
        this.status &= ~0xe0;
        if (this.rendering) this.vramAddress = this.tempAddress;
      } else if (this.line >= LINES_PER_FRAME) {
        this.line = 0;
        this.frameScrollX = ((this.vramAddress & 0x1f) << 3) | this.fineX;
        this.frameScrollY =
          (((this.vramAddress >> 5) & 0x1f) << 3) | ((this.vramAddress >> 12) & 7);
        this.frameNametable = (this.vramAddress >> 10) & 3;
      }
    }
  }

  /** Whether the beam is in VBlank — what a polling ROM waits on. */
  get inVblank(): boolean {
    return (this.status & 0x80) !== 0;
  }

  /** The scanline being drawn, for a harness that wants to know. */
  get scanline(): number {
    return this.line;
  }

  // --- rendering ---------------------------------------------------------------

  /** Draw one scanline: the background, then the sprites over (or under) it. */
  private renderLine(line: number): void {
    const base = line * SCREEN_WIDTH;
    const backdrop = this.palette[0] as number;
    this.indices.fill(backdrop, base, base + SCREEN_WIDTH);
    this.objRow.fill(0);
    this.bgOpaque.fill(0);
    if (!this.rendering) return;

    if ((this.mask & 0x08) !== 0) this.renderBackground(line, base);
    if ((this.mask & 0x10) !== 0) this.renderSprites(line, base);
  }

  private renderBackground(line: number, base: number): void {
    const patternBase = (this.control & 0x10) !== 0 ? 0x1000 : 0x0000;
    let worldY = this.frameScrollY + line;
    let nametable = this.frameNametable;
    // Vertical wrap happens at 240, not 256: the last two rows of a nametable
    // are the attribute table.
    if (worldY >= 240) {
      worldY -= 240;
      nametable ^= 2;
    }
    const row = worldY >> 3;
    const fineY = worldY & 7;

    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      let worldX = this.frameScrollX + x;
      let table = nametable;
      if (worldX >= 256) {
        worldX -= 256;
        table ^= 1;
      }
      const column = worldX >> 3;
      const mapBase = 0x2000 + table * 0x0400;
      const tile = this.readVram(mapBase + row * 32 + column);
      const address = patternBase + tile * 16 + fineY;
      const low = this.chr[address] ?? 0;
      const high = this.chr[address + 8] ?? 0;
      const shift = 7 - (worldX & 7);
      const index = ((low >> shift) & 1) | (((high >> shift) & 1) << 1);
      if (index === 0) continue; // the backdrop is already there
      // The attribute byte covers a 32×32 block and carries four 16×16 cells.
      const attribute = this.readVram(mapBase + 0x03c0 + (row >> 2) * 8 + (column >> 2));
      const quadrant = ((row & 2) << 1) | (column & 2);
      const palette = (attribute >> quadrant) & 3;
      this.bgOpaque[x] = 1;
      this.indices[base + x] = this.paletteColor(palette * 4 + index);
    }
  }

  private renderSprites(line: number, base: number): void {
    const tall = (this.control & 0x20) !== 0;
    const height = tall ? 16 : 8;
    const patternBase = (this.control & 0x08) !== 0 ? 0x1000 : 0x0000;

    // Sprite evaluation walks OAM in order and stops at eight; the ninth sets
    // the overflow flag and does not draw. Priority among those eight is OAM
    // order, so the first to claim a pixel keeps it.
    const chosen: number[] = [];
    for (let entry = 0; entry < 64; entry += 1) {
      const top = this.oam[entry * 4] as number;
      if (line < top || line >= top + height) continue;
      if (chosen.length === 8) {
        this.status |= 0x20;
        break;
      }
      chosen.push(entry);
    }

    for (const entry of chosen) {
      const top = this.oam[entry * 4] as number;
      const attributes = this.oam[entry * 4 + 2] as number;
      const left = this.oam[entry * 4 + 3] as number;
      let inner = line - top;
      if ((attributes & 0x80) !== 0) inner = height - 1 - inner;
      let tile = this.oam[entry * 4 + 1] as number;
      let address: number;
      if (tall) {
        // A tall sprite takes its pattern table from the tile's own low bit and
        // its second half from the next tile.
        const bank = (tile & 1) * 0x1000;
        tile &= 0xfe;
        address = bank + (tile + (inner >= 8 ? 1 : 0)) * 16 + (inner & 7);
      } else {
        address = patternBase + tile * 16 + inner;
      }
      const low = this.chr[address] ?? 0;
      const high = this.chr[address + 8] ?? 0;
      const behind = (attributes & 0x20) !== 0;
      const palette = 4 + (attributes & 3);

      for (let bit = 0; bit < 8; bit += 1) {
        const x = left + bit;
        if (x >= SCREEN_WIDTH) break;
        const shift = (attributes & 0x40) !== 0 ? bit : 7 - bit;
        const index = ((low >> shift) & 1) | (((high >> shift) & 1) << 1);
        if (index === 0) continue; // colour 0 is transparent for sprites
        if (entry === 0 && this.bgOpaque[x] === 1 && x !== 255) this.status |= 0x40;
        if (this.objRow[x] === 1) continue; // a higher-priority sprite has it
        this.objRow[x] = 1;
        if (behind && this.bgOpaque[x] === 1) continue;
        this.indices[base + x] = this.paletteColor(palette * 4 + index);
      }
    }
  }

  /** One palette RAM entry, with the grayscale bit applied. */
  private paletteColor(index: number): number {
    const code = this.palette[this.paletteIndex(index)] as number;
    return (this.mask & 0x01) !== 0 ? code & 0x30 : code & 0x3f;
  }

  /** Colour the finished frame into RGBA. */
  private present(): void {
    for (let pixel = 0; pixel < this.indices.length; pixel += 1) {
      const colour = NES_MASTER[(this.indices[pixel] as number) & 0x3f] as readonly [
        number,
        number,
        number,
      ];
      const at = pixel * 4;
      this.framebuffer[at] = colour[0];
      this.framebuffer[at + 1] = colour[1];
      this.framebuffer[at + 2] = colour[2];
      this.framebuffer[at + 3] = 0xff;
    }
  }
}
