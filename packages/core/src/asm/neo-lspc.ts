/**
 * The Neo Geo's video memory: where its structures are, and how their words are
 * built.
 *
 * Here rather than in the emulator for `megaduck.ts`'s reason, which this file
 * meets on the same terms: **three things need these numbers and a hardware fact
 * implemented three times is a fact that disagrees in one entry in one of them.**
 * `@demake/neogeo` needs them to *read* a strip, `@demake/demotic`'s backend to
 * write one, and the display-ROM builder at the CLI edge to place a picture. The
 * emulator re-exports what is here so a reader of `lspc.ts` still finds the whole
 * chip in one place.
 *
 * The one number in it worth arguing about is the Y convention: a strip's SCB3
 * word stores `496 − y`, so a larger stored value is a *higher* strip and zero is
 * the top of the visible frame. It is the documented formula, and
 * `packages/cli/test/neogeo.e2e.test.ts` is where it is settled against a
 * third-party emulator rather than against our own renderer — which is the only
 * kind of check a shared convention can fail.
 *
 * Sources:
 * - Neo Geo Development Wiki — Sprites: https://wiki.neogeodev.org/index.php?title=Sprites
 * - Neo Geo Development Wiki — VRAM: https://wiki.neogeodev.org/index.php?title=VRAM
 */

/** Words of VRAM: 64 KiB lower plus 4 KiB upper, addressed as words throughout. */
export const NEO_VRAM_WORDS = 0x8800;

/** Where each structure starts, in words. */
export const NEO_SCB1 = 0x0000;
/** The fix layer's 40×32 map, column-major. */
export const NEO_FIX_MAP = 0x7000;
/** Shrinking, one word a sprite: `$0FFF` is full width and full height. */
export const NEO_SCB2 = 0x8000;
/** Y position, sticky bit and height, one word a sprite. */
export const NEO_SCB3 = 0x8200;
/** X position, one word a sprite. */
export const NEO_SCB4 = 0x8400;

/** Words of SCB1 per sprite: thirty-two rows of a tile number and its attribute. */
export const NEO_SCB1_STRIDE = 64;

/**
 * The SCB2 word that means *no shrinking at all*.
 *
 * Zero is fully shrunk rather than unshrunk, so a strip whose SCB2 was never
 * written draws one line of itself — which is a cartridge that is perfect and
 * shows a row of dots. The high nibble is horizontal and the low byte vertical.
 */
export const NEO_SCB2_FULL = 0x0fff;

/** Palette entries in one bank: 256 palettes of 16. */
export const NEO_PALETTE_ENTRIES = 256 * 16;

/**
 * The bank entry the backdrop comes from: the last one.
 *
 * Colour zero of every palette is transparent here, so what shows through a
 * picture's own index 0 is this entry rather than palette zero's first colour.
 */
export const NEO_BACKDROP_ENTRY = NEO_PALETTE_ENTRIES - 1;

/**
 * The first sprite a program may place.
 *
 * **Sprite 0 belongs to the hardware.** It is what the LSPC pads a line's
 * display list with, so it is expected to be left fully transparent and is
 * reported to draw over everything else regardless of the ordering — two
 * reasons not to put a playfield column in it.
 */
export const NEO_FIRST_SPRITE = 1;

/** Fix map dimensions. The map is 40×32; NTSC shows 40×28. */
export const NEO_FIX_COLUMNS = 40;
export const NEO_FIX_ROWS = 32;

/** How a strip's SCB3 word decomposes. */
export interface NeoStripPosition {
  /** Screen Y of the strip's top row. The hardware stores `496 - y`. */
  y: number;
  /** Chained to the strip before it: same Y and height, drawn 16px to its right. */
  sticky: boolean;
  /** Tiles tall, 0–63; only the first 32 have SCB1 entries. */
  height: number;
}

/** Read SCB3's three fields. */
export function decodeScb3(word: number): NeoStripPosition {
  const stored = (word >> 7) & 0x1ff;
  return {
    y: (496 - stored) & 0x1ff,
    sticky: ((word >> 6) & 1) === 1,
    height: word & 0x3f,
  };
}

/** Build an SCB3 word from a screen position. The inverse of {@link decodeScb3}. */
export function encodeScb3(position: NeoStripPosition): number {
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
export interface NeoTileAttribute {
  palette: number;
  tileHigh: number;
  vflip: boolean;
  hflip: boolean;
}

/** Decode SCB1's attribute word. */
export function decodeAttribute(word: number): NeoTileAttribute {
  return {
    palette: (word >> 8) & 0xff,
    tileHigh: (word >> 4) & 0xf,
    vflip: ((word >> 1) & 1) === 1,
    hflip: (word & 1) === 1,
  };
}

/** Build SCB1's attribute word. The inverse of {@link decodeAttribute}. */
export function encodeAttribute(attribute: NeoTileAttribute): number {
  return (
    ((attribute.palette & 0xff) << 8) |
    ((attribute.tileHigh & 0xf) << 4) |
    (attribute.vflip ? 2 : 0) |
    (attribute.hflip ? 1 : 0)
  );
}
