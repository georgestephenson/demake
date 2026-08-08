/**
 * The LSPC: the Neo Geo's video hardware, and the reason this console is cheaper
 * than its reputation.
 *
 * **There is no tilemap and none is needed.** A sprite here is a *vertical
 * strip* — sixteen pixels wide, up to thirty-two tiles tall — whose column of
 * tile numbers is a 64-word table in VRAM. So twenty-one strips side by side are
 * a plane of 16×16 cells that a runtime scrolls with two register writes and
 * paints one cell at a time, which is a tilemap in everything but the name. Doc
 * 13 priced this console at "all five background-cell writers need
 * counterparts"; what they need is a different address calculation.
 *
 * Three things about the arrangement are this hardware's and are load-bearing
 * above it.
 *
 *   - **The sticky bit chains a strip to the one before it.** A sticky sprite
 *     takes the previous sprite's Y and height and is drawn immediately to its
 *     right, so a plane's twenty-one strips carry *one* position between them:
 *     scrolling is a write to sprite 0's SCB3 and SCB4 and nothing else. No
 *     other console in the set has a scroll that cheap, and none has a seam
 *     either, because the plane is 336 pixels against a 320-pixel screen.
 *   - **Tiles are not in VRAM.** VRAM holds tile *numbers*; the pixels are read
 *     from the cartridge's C ROM by the video hardware. Nothing is ever
 *     uploaded, there is no bank to run out of, and a picture's tile budget is a
 *     cartridge size — which is why {@link Lspc} is handed the character ROM at
 *     construction rather than filling one through a port.
 *   - **The fix layer is in front of everything.** A separate 8×8 map at VRAM
 *     `$7000`, 40×32 entries stored *column-major*, non-scrollable, always over
 *     the sprites. That is a HUD layer the hardware gives away, so the sprite
 *     HUD and the pixel-pinning argument every 8-bit console in the set needs
 *     are absent here the way they are on a Game Boy Advance.
 *
 * **Two descriptions here are unverified and say so**, on the
 * `NGP_BUTTON_BITS` precedent (AGENTS.md §Gotchas): a machine description that
 * is wrong *and* consistent passes every test there is, so the guesses are
 * written down rather than hidden. They are {@link SPRITE_ORDER_FRONT_TO_BACK}
 * and the dark bit's role in {@link expandColor}, and each is one line to change.
 *
 * Sources:
 * - Neo Geo Development Wiki — Sprites: https://wiki.neogeodev.org/index.php?title=Sprites
 * - Neo Geo Development Wiki — VRAM: https://wiki.neogeodev.org/index.php?title=VRAM
 * - Neo Geo Development Wiki — Palettes: https://wiki.neogeodev.org/index.php?title=Palettes
 * - Neo Geo Development Wiki — Colors: https://wiki.neogeodev.org/index.php?title=Colors
 * - Neo Geo Development Wiki — Fix layer: https://wiki.neogeodev.org/index.php?title=Fix_layer
 */

/** The visible frame. */
export const FRAME_WIDTH = 320;
/** The visible frame, NTSC. */
export const FRAME_HEIGHT = 224;

/** Sprites the hardware will consider in one frame. */
export const SPRITE_COUNT = 381;
/** Sprites the hardware will draw on one scanline — four times an 8-bit console's. */
export const SPRITES_PER_LINE = 96;

/** Words of VRAM: 64 KiB lower plus 4 KiB upper, addressed as words throughout. */
export const VRAM_WORDS = 0x8800;

/** Where each structure starts, in words. */
export const SCB1 = 0x0000;
/** The fix layer's 40×32 map, column-major. */
export const FIX_MAP = 0x7000;
/** Shrinking, one word a sprite. Modelled as read/write storage only. */
export const SCB2 = 0x8000;
/** Y position, sticky bit and height, one word a sprite. */
export const SCB3 = 0x8200;
/** X position, one word a sprite. */
export const SCB4 = 0x8400;

/** Words of SCB1 per sprite: thirty-two rows of a tile number and its attribute. */
export const SCB1_STRIDE = 64;

/** Palette entries in one bank: 256 palettes of 16. */
export const PALETTE_ENTRIES = 256 * 16;

/** Fix map dimensions. The map is 40×32; NTSC shows 40×28. */
export const FIX_COLUMNS = 40;
export const FIX_ROWS = 32;

/**
 * Whether sprite 0 is drawn in front of sprite 380 or behind it.
 *
 * **Unverified.** The references this project could reach state the sprite list
 * is walked in index order and do not say which end wins a contested pixel. The
 * reading taken here is that a *lower* index is in front, which is the Super
 * Nintendo's convention and the more common one — and the backend above is
 * written not to care: it puts the playfield at the high indices and objects at
 * the low ones, so if this is backwards it is this constant that changes and not
 * a line of generated code.
 */
export const SPRITE_ORDER_FRONT_TO_BACK = true;

/** One frame, as straight RGBA. */
export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Expand a Neo Geo colour word to eight bits a channel.
 *
 * Bit 15 is the dark bit, bits 14–12 are the least significant bits of red,
 * green and blue, and bits 11–0 are their four high bits in that order — so a
 * channel is five bits, assembled high-nibble first.
 *
 * **The dark bit's role is unverified.** The same reference that gives the
 * layout above also calls bit 15 "a common LSB for the three components", which
 * would make each channel six bits rather than five and this function wrong in
 * its low bit. Five is the reading every source agrees on and is what the console
 * spec declares, so it is what is implemented; the alternative is one line here
 * and one in the spec. Treating it as a *darkening* multiplier — the third
 * possible reading — is deliberately not done, because a model that dimmed a
 * colour nothing asked to dim would be inventing hardware.
 */
export function expandColor(word: number): [number, number, number] {
  const lsbR = (word >> 14) & 1;
  const lsbG = (word >> 13) & 1;
  const lsbB = (word >> 12) & 1;
  const r5 = (((word >> 8) & 0xf) << 1) | lsbR;
  const g5 = (((word >> 4) & 0xf) << 1) | lsbG;
  const b5 = ((word & 0xf) << 1) | lsbB;
  return [expand5(r5), expand5(g5), expand5(b5)];
}

/** Five bits to eight, by replication — the lattice the console spec declares. */
function expand5(value: number): number {
  return (value << 3) | (value >> 2);
}

/** How a strip's SCB3 word decomposes. */
export interface StripPosition {
  /** Screen Y of the strip's top row. The hardware stores `496 - y`. */
  y: number;
  /** Chained to the strip before it: same Y and height, drawn 16px to its right. */
  sticky: boolean;
  /** Tiles tall, 0–63; only the first 32 have SCB1 entries. */
  height: number;
}

/** Read SCB3's three fields. */
export function decodeScb3(word: number): StripPosition {
  const stored = (word >> 7) & 0x1ff;
  return {
    y: (496 - stored) & 0x1ff,
    sticky: ((word >> 6) & 1) === 1,
    height: word & 0x3f,
  };
}

/** Build an SCB3 word from a screen position. The inverse of {@link decodeScb3}. */
export function encodeScb3(position: StripPosition): number {
  const stored = (496 - position.y) & 0x1ff;
  return (stored << 7) | (position.sticky ? 0x40 : 0) | (position.height & 0x3f);
}

/** Read SCB4's single field: the strip's screen X. */
export function decodeScb4(word: number): number {
  return (word >> 7) & 0x1ff;
}

/** Build an SCB4 word. The inverse of {@link decodeScb4}. */
export function encodeScb4(x: number): number {
  return (x & 0x1ff) << 7;
}

/** What a sprite's odd SCB1 word carries beside the tile number's high bits. */
export interface TileAttribute {
  palette: number;
  tileHigh: number;
  vflip: boolean;
  hflip: boolean;
}

/** Decode SCB1's attribute word. */
export function decodeAttribute(word: number): TileAttribute {
  return {
    palette: (word >> 8) & 0xff,
    tileHigh: (word >> 4) & 0xf,
    vflip: ((word >> 1) & 1) === 1,
    hflip: (word & 1) === 1,
  };
}

/** Build SCB1's attribute word. The inverse of {@link decodeAttribute}. */
export function encodeAttribute(attribute: TileAttribute): number {
  return (
    ((attribute.palette & 0xff) << 8) |
    ((attribute.tileHigh & 0xf) << 4) |
    (attribute.vflip ? 2 : 0) |
    (attribute.hflip ? 1 : 0)
  );
}

/** Everything the renderer is handed that is not VRAM. */
export interface LspcOptions {
  /** Sprite tile pixels: the cartridge's C ROM, one byte a pixel, 256 a tile. */
  characters: Uint8Array;
  /** Fix layer tile pixels: the cartridge's S ROM, one byte a pixel, 64 a tile. */
  fixCharacters: Uint8Array;
}

/**
 * The video hardware.
 *
 * VRAM and palette RAM are this object's, because on this console the processor
 * reaches both through ports rather than by addressing them — which is the
 * opposite of the WonderSwan's arrangement and the reason `Display` there is
 * handed the machine's own memory instead.
 */
export class Lspc {
  /** 68 KiB, addressed as words. */
  readonly vram = new Uint16Array(VRAM_WORDS);
  /** Two banks of 256 palettes of 16; one is selected at a time. */
  readonly palettes = [new Uint16Array(PALETTE_ENTRIES), new Uint16Array(PALETTE_ENTRIES)];
  /** Which palette bank the video output reads. */
  paletteBank = 0;

  /** The VRAM address port, in words. */
  address = 0;
  /** Added to {@link address} after every write through the data port. */
  modulo = 0;

  private readonly characters: Uint8Array;
  private readonly fixCharacters: Uint8Array;
  private readonly frame: Uint8ClampedArray;

  constructor(options: LspcOptions) {
    this.characters = options.characters;
    this.fixCharacters = options.fixCharacters;
    this.frame = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);
  }

  /** Read the word the address port points at. Does not auto-increment. */
  readData(): number {
    return this.vram[this.address & (VRAM_WORDS - 1)] ?? 0;
  }

  /** Write through the data port; the modulo is applied afterwards. */
  writeData(value: number): void {
    this.vram[this.address & (VRAM_WORDS - 1)] = value & 0xffff;
    this.address = (this.address + this.modulo) & 0xffff;
  }

  /** The backdrop: the last colour of the active bank (`$401FFE` on the bus). */
  backdrop(): number {
    return this.palettes[this.paletteBank]![PALETTE_ENTRIES - 1] ?? 0;
  }

  /**
   * Draw a frame.
   *
   * Per scanline, because that is where this hardware's one budget lives: the
   * LSPC will draw ninety-six strips on a line and stops there, so a renderer
   * that composited whole sprites would never reproduce a frame that overran.
   */
  render(): Frame {
    const bank = this.palettes[this.paletteBank]!;
    const [br, bg, bb] = expandColor(this.backdrop());
    for (let y = 0; y < FRAME_HEIGHT; y += 1) {
      const row = y * FRAME_WIDTH * 4;
      for (let x = 0; x < FRAME_WIDTH; x += 1) {
        const at = row + x * 4;
        this.frame[at] = br;
        this.frame[at + 1] = bg;
        this.frame[at + 2] = bb;
        this.frame[at + 3] = 255;
      }
      this.renderSpriteLine(y, bank);
      this.renderFixLine(y, bank);
    }
    return { width: FRAME_WIDTH, height: FRAME_HEIGHT, data: this.frame };
  }

  /**
   * One scanline of the sprite plane.
   *
   * The walk is back-to-front so a nearer strip simply overwrites, which is why
   * {@link SPRITE_ORDER_FRONT_TO_BACK} is consulted here and nowhere else. The
   * per-line budget is counted over strips that *cover* the line, which is what
   * the hardware evaluates rather than what the list holds.
   */
  private renderSpriteLine(y: number, bank: Uint16Array): void {
    const order: number[] = [];
    let chainY = 0;
    let chainHeight = 0;
    let chainX = 0;
    for (let index = 0; index < SPRITE_COUNT; index += 1) {
      const position = decodeScb3(this.vram[SCB3 + index] ?? 0);
      if (position.sticky && index > 0) {
        chainX = (chainX + 16) & 0x1ff;
      } else {
        chainY = position.y;
        chainHeight = position.height;
        chainX = decodeScb4(this.vram[SCB4 + index] ?? 0);
      }
      if (chainHeight === 0) continue;
      const pixelHeight = Math.min(chainHeight, 32) * 16;
      const top = chainY;
      if (y < top || y >= top + pixelHeight) continue;
      if (chainX >= FRAME_WIDTH && chainX + 16 <= 0x1ff) continue;
      order.push(index === 0 || !position.sticky ? index : index);
      if (order.length >= SPRITES_PER_LINE) break;
    }
    const walk = SPRITE_ORDER_FRONT_TO_BACK ? [...order].reverse() : order;
    // Recomputing the chain per drawn strip keeps this function's state local;
    // the list above is only which indices survived the budget.
    for (const index of walk) this.drawStripLine(index, y, bank);
  }

  /** Resolve a strip's chained position, then plot its sixteen pixels on line `y`. */
  private drawStripLine(index: number, y: number, bank: Uint16Array): void {
    let anchor = index;
    let x = 0;
    while (anchor > 0 && decodeScb3(this.vram[SCB3 + anchor] ?? 0).sticky) {
      anchor -= 1;
      x += 16;
    }
    const position = decodeScb3(this.vram[SCB3 + anchor] ?? 0);
    x = (decodeScb4(this.vram[SCB4 + anchor] ?? 0) + x) & 0x1ff;
    const withinPixels = y - position.y;
    const rowIndex = withinPixels >> 4;
    if (rowIndex < 0 || rowIndex >= Math.min(position.height, 32)) return;
    const base = SCB1 + index * SCB1_STRIDE + rowIndex * 2;
    const attribute = decodeAttribute(this.vram[base + 1] ?? 0);
    const tile = ((attribute.tileHigh << 16) | (this.vram[base] ?? 0)) >>> 0;
    const withinTile = withinPixels & 15;
    const tileRow = attribute.vflip ? 15 - withinTile : withinTile;
    const paletteBase = attribute.palette * 16;
    const pixels = tile * 256 + tileRow * 16;
    for (let column = 0; column < 16; column += 1) {
      const screenX = x + column;
      if (screenX < 0 || screenX >= FRAME_WIDTH) continue;
      const source = attribute.hflip ? 15 - column : column;
      const value = this.characters[pixels + source] ?? 0;
      if (value === 0) continue;
      this.plot(screenX, y, bank[paletteBase + value] ?? 0);
    }
  }

  /**
   * One scanline of the fix layer, which is in front of every sprite.
   *
   * The map is stored **column-major** — "top to bottom, left to right" — so a
   * cell's word is `column × 32 + row` and not `row × 40 + column`. A renderer
   * with those the other way round draws a recognisable but transposed HUD,
   * which is exactly the class of mistake that survives a register diff.
   */
  private renderFixLine(y: number, bank: Uint16Array): void {
    const row = y >> 3;
    if (row >= FIX_ROWS) return;
    const withinTile = y & 7;
    for (let column = 0; column < FIX_COLUMNS; column += 1) {
      const entry = this.vram[FIX_MAP + column * FIX_ROWS + row] ?? 0;
      const tile = entry & 0x0fff;
      // The fix layer reaches only the first sixteen palettes of the bank.
      const paletteBase = ((entry >> 12) & 0xf) * 16;
      const pixels = tile * 64 + withinTile * 8;
      for (let pixel = 0; pixel < 8; pixel += 1) {
        const value = this.fixCharacters[pixels + pixel] ?? 0;
        if (value === 0) continue;
        const x = column * 8 + pixel;
        if (x >= FRAME_WIDTH) continue;
        this.plot(x, y, bank[paletteBase + value] ?? 0);
      }
    }
  }

  private plot(x: number, y: number, color: number): void {
    const at = (y * FRAME_WIDTH + x) * 4;
    const [r, g, b] = expandColor(color);
    this.frame[at] = r;
    this.frame[at + 1] = g;
    this.frame[at + 2] = b;
    this.frame[at + 3] = 255;
  }
}
