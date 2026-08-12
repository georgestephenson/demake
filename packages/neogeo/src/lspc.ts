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
 *     scrolling is a write to the anchor strip's SCB3 and SCB4 and nothing
 *     else. No
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
 * **Nothing here is a guess any more, and two of the constants record what it
 * cost to stop guessing.** {@link SPRITE_ORDER_FRONT_TO_BACK} shipped with the
 * Super Nintendo's convention and the reference says the opposite; being a named
 * constant carrying its own uncertainty is what made that a one-line correction
 * rather than archaeology. {@link expandColor}'s dark bit went the other way —
 * confirmed, and then deliberately *not* modelled, for reasons that file states.
 * That is the `NGP_BUTTON_BITS` rule paying for itself twice (AGENTS.md
 * §Gotchas): a machine description that is wrong *and* consistent passes every
 * test there is, so the way to survive one is to write the doubt down beside it.
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

/**
 * VRAM's structures and the words they hold, which are `@demake/core`'s.
 *
 * Three things need them — this renderer, the game backend and the display-ROM
 * builder — so they live beside the cartridge wrapper in `asm/neo-lspc.ts` and
 * are re-exported here under the names this file has always used, because a
 * reader of the chip should still find the whole chip in one place.
 */
import {
  NEO_FIX_COLUMNS as FIX_COLUMNS,
  NEO_FIX_MAP as FIX_MAP,
  NEO_FIX_ROWS as FIX_ROWS,
  NEO_PALETTE_ENTRIES as PALETTE_ENTRIES,
  NEO_SCB1 as SCB1,
  NEO_SCB1_STRIDE as SCB1_STRIDE,
  NEO_SCB3 as SCB3,
  NEO_SCB4 as SCB4,
  NEO_VRAM_WORDS as VRAM_WORDS,
  decodeAttribute,
  decodeScb3,
  decodeScb4,
} from "@demake/core";

export {
  NEO_VRAM_WORDS as VRAM_WORDS,
  NEO_SCB1 as SCB1,
  NEO_SCB1_STRIDE as SCB1_STRIDE,
  NEO_SCB2 as SCB2,
  NEO_SCB2_FULL as SCB2_FULL,
  NEO_SCB3 as SCB3,
  NEO_SCB4 as SCB4,
  NEO_FIX_MAP as FIX_MAP,
  NEO_FIX_COLUMNS as FIX_COLUMNS,
  NEO_FIX_ROWS as FIX_ROWS,
  NEO_PALETTE_ENTRIES as PALETTE_ENTRIES,
  decodeScb3,
  encodeScb3,
  decodeScb4,
  encodeScb4,
  decodeAttribute,
  encodeAttribute,
  type NeoStripPosition as StripPosition,
  type NeoTileAttribute as TileAttribute,
} from "@demake/core";

/**
 * Whether a *lower* sprite index is drawn in front of a higher one.
 *
 * **It is not**, and this constant records that the question was asked. The
 * NeoGeo Development Wiki is explicit: sprites are numbered by priority, so a
 * lower number is drawn *behind* a higher one. That is the opposite of the Super
 * Nintendo's convention and the opposite of the guess this file shipped with,
 * which is exactly why it was a named constant and why the backend above is
 * written not to care — the playfield takes the low indices and objects the
 * high ones, so objects are in front.
 */
export const SPRITE_ORDER_FRONT_TO_BACK = false;

/**
 * The first sprite a program may use, which is `@demake/core`'s — the display-ROM
 * builder places a playfield too, and one hardware fact has one home.
 */
export { NEO_FIRST_SPRITE as FIRST_USABLE_SPRITE } from "@demake/core";

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
 * **The dark bit is confirmed and deliberately not modelled**, which is a
 * different thing from unverified. The reference's table is explicit — bit 15 is
 * the "Dark bit, used as a common LSB for the 3 components" — so a channel is
 * five bits of its own plus a sixth the three *share*.
 *
 * Two things follow, and the first is why the console spec declares five bits a
 * channel rather than six. A shared bit cannot be chosen per channel, so six-bit
 * independence is precision the hardware does not have: a fit told it had
 * `[6, 6, 6]` would pick colours no palette word can express. Five is the
 * *independently choosable* precision and is therefore the honest lattice.
 *
 * The second is why this function ignores the bit rather than folding it in.
 * Its polarity is undocumented, and the one value the hardware pins contradicts
 * the naive reading: `$400000` must be pure black and is written `$8000` — the
 * dark bit *set*, every channel zero. As an ordinary least significant bit that
 * would be one step above black, not black. So the sources fix the bit's
 * position and not its sense, `encodeColour` writes it as zero for every colour
 * but that reference, and the sixth of a step it is worth is left out rather
 * than guessed at — `s-dsp.ts`'s Gaussian interpolation and the YM2612's busy
 * flag are absent on the same terms.
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

  /**
   * Read the word the address port points at. Does not auto-increment.
   *
   * Bounds-checked rather than masked, for the reason {@link writeData} gives.
   */
  readData(): number {
    return this.address < VRAM_WORDS ? (this.vram[this.address] ?? 0) : 0;
  }

  /**
   * Write through the data port; the modulo is applied afterwards.
   *
   * **The address is bounds-checked, not masked.** VRAM here is `$8800` words —
   * 64 KiB plus a 4 KiB upper zone — which is *not* a power of two, so
   * `address & (VRAM_WORDS - 1)` is not a wrap at all: it clears bits rather
   * than reducing modulo, and `$737A & $87FF` is `$037A`. That folded every
   * write to the fix map, which lives at `$7000`, down into the middle of the
   * sprite control block — a caption written perfectly and landing in the tile
   * numbers of a strip nobody was looking at.
   *
   * The address register is sixteen bits and the hardware decodes nothing above
   * the upper zone, so out of range is dropped. Masking a non-power-of-two size
   * is the kind of thing that looks like a wrap and is not.
   */
  writeData(value: number): void {
    if (this.address < VRAM_WORDS) this.vram[this.address] = value & 0xffff;
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
