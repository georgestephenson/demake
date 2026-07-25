/**
 * The runtime's built-in tile bank: a text font, level-tile patterns, and the
 * block an object is drawn as until real art is bound.
 *
 * It lives in the emitted tables rather than inside the assembled runtime for
 * one reason: it is *data*, and data is the thing this format exists to carry.
 * Authoring a font as ASCII art in TypeScript that a test can read back beats
 * a kilobyte of hand-written `db` lines nobody can proofread, and it means the
 * day a Demakefile binds real art (doc 15 §The conversion path) the sprite
 * tiles append to this same blob instead of needing a second mechanism.
 *
 * **This is the interim art path, and it is deliberate.** Doc 15 step 2 —
 * rasterising vector sources — does not exist yet, and deterministic SVG
 * rasterisation across Node and browsers fights the byte-determinism rule
 * (doc 14 §Known gaps). Rather than block a playable ROM on it, an object with
 * a `sprite` draws as a solid block: the game *plays* correctly and looks like
 * the era's own placeholder art, and `INSTANCE.tile` already carries the field
 * that real art will fill.
 */

/** Bytes per Game Boy 2bpp tile. */
export const TILE_BYTES = 16;

/** First character the font covers. */
export const FONT_FIRST = 32;

/** Last character the font covers (`Z`). Anything outside draws as a space. */
export const FONT_LAST = 90;

/** Tiles the font occupies, one per covered character. */
export const FONT_COUNT = FONT_LAST - FONT_FIRST + 1;

/** Tile index of the first font glyph (a space, so it doubles as "blank"). */
export const FONT_BASE = 0;

/** Tile index of the first level-tile pattern. */
export const PATTERN_BASE = FONT_COUNT;

/** Distinct level-tile patterns: two solid-looking, two open-looking. */
export const PATTERN_COUNT = 4;

/** Tile index of the block an object without bound art draws as. */
export const OBJECT_TILE = PATTERN_BASE + PATTERN_COUNT;

/** Total tiles in the built-in bank. */
export const BUILTIN_TILES = OBJECT_TILE + 1;

/**
 * A 5×7 font in an 8×8 cell, one row per string, `#` for ink.
 *
 * 5×7 because that is what fits legibly beside a one-pixel margin, and because
 * a score in the corner of a 20-cell-wide Game Boy screen has no room to be
 * more ambitious. Characters not listed render blank, which is what an
 * out-of-range byte should look like: absent, not corrupt.
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "'": ["..#..", "..#..", ".....", ".....", ".....", ".....", "....."],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  ",": [".....", ".....", ".....", ".....", "..#..", "..#..", ".#..."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", "..#..", "..#.."],
  "/": ["....#", "...#.", "...#.", "..#..", ".#...", ".#...", "#...."],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  ":": [".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."],
  "<": ["...#.", "..#..", ".#...", "#....", ".#...", "..#..", "...#."],
  "=": [".....", ".....", "#####", ".....", "#####", ".....", "....."],
  ">": [".#...", "..#..", "...#.", "....#", "...#.", "..#..", ".#..."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "####.", "#...#", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["###..", "#..#.", "#...#", "#...#", "#...#", "#..#.", "###.."],
  E: ["#####", "#....", "####.", "#....", "#....", "#....", "#####"],
  F: ["#####", "#....", "####.", "#....", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["....#", "....#", "....#", "....#", "#...#", "#...#", ".###."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
};

/**
 * Level-tile patterns, as 8×8 colour indices.
 *
 * Two dense and two sparse, because the one thing a player must be able to read
 * off a screen is which tiles stop them: the emitter hands `solid` legend
 * entries a dense pattern and scenery a sparse one, so "can I walk through
 * this" is visible without art.
 */
const PATTERNS: readonly (readonly string[])[] = [
  // 0 — solid brick, the default wall.
  ["33333333", "32222223", "32222223", "33333333", "22233222", "22233222", "22233222", "33333333"],
  // 1 — dense hatch, the second solid.
  ["33333333", "30303030", "33333333", "03030303", "33333333", "30303030", "33333333", "03030303"],
  // 2 — sparse dots, scenery.
  ["00000000", "00200200", "00000000", "02000020", "00000000", "00200200", "00000000", "00000000"],
  // 3 — a ring, the second scenery tile.
  ["00000000", "00222200", "02000020", "02000020", "02000020", "02000020", "00222200", "00000000"],
];

/** A wholly filled cell — what an object draws as until art is bound. */
const OBJECT_BLOCK: readonly string[] = [
  "33333333",
  "33333333",
  "33333333",
  "33333333",
  "33333333",
  "33333333",
  "33333333",
  "33333333",
];

/**
 * Encode one 8×8 cell of colour indices (`0`–`3`) as a Game Boy 2bpp tile.
 *
 * Two bitplanes interleaved by row, low plane first, leftmost pixel in bit 7 —
 * the same packing `@demake/core`'s `gb` codegen emits, kept here rather than
 * imported because `@demake/demotic` has no dependency on the image engine and
 * gains nothing by acquiring one for sixteen bytes.
 */
function encodeTile(rows: readonly string[]): Uint8Array {
  const bytes = new Uint8Array(TILE_BYTES);
  for (let y = 0; y < 8; y += 1) {
    const row = rows[y] ?? "";
    let low = 0;
    let high = 0;
    for (let x = 0; x < 8; x += 1) {
      const colour = Number.parseInt(row[x] ?? "0", 10) || 0;
      if (colour & 1) low |= 0x80 >> x;
      if (colour & 2) high |= 0x80 >> x;
    }
    bytes[y * 2] = low;
    bytes[y * 2 + 1] = high;
  }
  return bytes;
}

/** Expand a 5×7 glyph into an 8×8 cell of colour indices, ink at colour 3. */
function glyphRows(character: string): readonly string[] {
  const art = GLYPHS[character];
  const rows: string[] = [];
  for (let y = 0; y < 8; y += 1) {
    const line = art?.[y];
    if (!line) {
      rows.push("00000000");
      continue;
    }
    // One blank column of side bearing, so adjacent characters do not touch.
    rows.push(`0${[...line].map((cell) => (cell === "#" ? "3" : "0")).join("")}00`);
  }
  return rows;
}

/**
 * The built-in tile bank: font, then patterns, then the object block.
 *
 * Order is part of the format — the runtime maps a character to a tile with one
 * subtraction, and the emitter hands legend entries a pattern by index — so it
 * is fixed here and asserted by the format test rather than being incidental.
 */
export function builtinTiles(): Uint8Array {
  const bank = new Uint8Array(BUILTIN_TILES * TILE_BYTES);
  let at = 0;
  for (let code = FONT_FIRST; code <= FONT_LAST; code += 1) {
    bank.set(encodeTile(glyphRows(String.fromCharCode(code))), at);
    at += TILE_BYTES;
  }
  for (const pattern of PATTERNS) {
    bank.set(encodeTile(pattern), at);
    at += TILE_BYTES;
  }
  bank.set(encodeTile(OBJECT_BLOCK), at);
  return bank;
}

/**
 * The tile a level legend entry draws as.
 *
 * Solid entries get a dense pattern and scenery a sparse one — see
 * {@link PATTERNS} — with the index alternating so two adjacent walls in one
 * legend stay distinguishable.
 */
export function patternTile(legendIndex: number, solid: boolean): number {
  const base = solid ? 0 : 2;
  return PATTERN_BASE + base + (legendIndex % 2);
}

/** The tile that draws one character, or a space for anything uncovered. */
export function glyphTile(character: string): number {
  const code = character.toUpperCase().charCodeAt(0);
  if (Number.isNaN(code) || code < FONT_FIRST || code > FONT_LAST) return FONT_BASE;
  return FONT_BASE + (code - FONT_FIRST);
}
