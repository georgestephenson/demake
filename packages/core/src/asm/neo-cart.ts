/**
 * The Neo Geo cartridge: its program header, its two graphics formats, and the
 * single-file container they ship in.
 *
 * Here rather than in a caller for `md-cart.ts`'s reason: more than one builder
 * wraps 68000 code into a Neo Geo cartridge, and a header implemented twice is a
 * header that disagrees in one byte in one of them.
 *
 * **A Neo Geo cartridge is not one ROM.** The board carries a P ROM the 68000
 * executes, an S ROM the fix layer reads, a C ROM pair the sprite hardware
 * reads, and — on a board with sound — an M ROM and V ROMs the Z80 side reads.
 * They sit on different buses and no address space contains all of them, so
 * "the cartridge" is a *set*. {@link packNeoRom} writes the `.neo` container,
 * which is the documented single-file arrangement flash carts use: a 4096-byte
 * header naming each region's length, then the regions end to end. That keeps
 * `demake build` writing one artifact, which is what every other console does
 * and what doc 15 assumes.
 *
 * ## The two graphics formats, and why they are encoded here
 *
 * Both are peculiar and both are the kind of thing that is wrong *and*
 * consistent if an encoder and a reader are written together (AGENTS.md
 * §Gotchas — the Neo Geo Pocket's BGR palette is the same trap). So the
 * encoders live here and `packages/core/test/neo-cart.test.ts` pins them against
 * byte offsets computed by hand from the format description rather than against
 * a decoder of ours. `@demake/neogeo` then *decodes* what a cartridge carries
 * rather than being handed pixels ready-made, which is the other half of the
 * same argument: a block order nothing ever unpacked would be a cartridge nobody
 * had checked was readable.
 *
 *   - **A sprite tile is four 8×8 blocks and the first one is the top
 *     _right_.** The order is (8,0), (8,8), (0,0), (0,8) — right half before
 *     left, which no other console in the set does. Planes 0 and 1 go in the odd
 *     C ROM and planes 2 and 3 in the even one, two bytes a row each, so a
 *     16×16 tile is 64 bytes in each of a pair and 128 altogether.
 *   - **A fix tile is stored in columns, and its right half comes first.** Four
 *     column pairs of eight rows, addressed `H C LLL` with `H` selecting the
 *     half and `H = 0` meaning the *right* one — the same right-before-left
 *     quirk. Two horizontally adjacent pixels share a byte and they are
 *     swapped: the left pixel is the low nibble.
 *
 * Sources:
 * - Neo Geo Development Wiki — Sprite graphics format:
 *   https://wiki.neogeodev.org/index.php?title=Sprite_graphics_format
 * - Neo Geo Development Wiki — Fix graphics format:
 *   https://wiki.neogeodev.org/index.php?title=Fix_graphics_format
 * - Neo Geo Development Wiki — 68k program header:
 *   https://wiki.neogeodev.org/index.php?title=68k_program_header
 * - Terraonion — Neobuilder guide (the `.neo` header's field order and its
 *   4096-byte length): https://wiki.terraonion.com/index.php/Neobuilder_Guide
 * - `city41/neosdconv`, `src/buildNeoFile.ts` — the C region's byte interleave.
 */

/** Bytes one 16×16 sprite tile occupies across the C ROM pair. */
export const NEO_TILE_BYTES = 128;
/** Bytes it occupies in *one* of the pair. */
export const NEO_TILE_PLANE_BYTES = 64;
/** Bytes one 8×8 fix tile occupies in the S ROM. */
export const NEO_FIX_TILE_BYTES = 32;

/** Where the console's boot ROM looks for the cartridge header. */
export const NEO_HEADER_OFFSET = 0x100;
/** The `JMP USER` the boot hand-off enters through. */
export const NEO_USER_ENTRY = 0x122;
/** Where a demade program's own code starts, past the header's jump table. */
export const NEO_CODE_ORIGIN = 0x200;

/** Bytes the `.neo` container's header occupies before the first region. */
export const NEO_CONTAINER_HEADER = 4096;

/**
 * The four 8×8 blocks of a sprite tile, in the order the C ROM stores them.
 *
 * Right half before left, which is the single most surprising thing about this
 * format and the reason it is a named constant rather than arithmetic.
 */
export const NEO_BLOCK_ORIGINS: readonly (readonly [number, number])[] = [
  [8, 0],
  [8, 8],
  [0, 0],
  [0, 8],
];

/**
 * Encode 16×16 tiles into the C ROM pair.
 *
 * `pixels` is one byte a pixel, row-major within each tile, 256 bytes a tile —
 * the decoded form the image pipeline produces and `@demake/neogeo` consumes.
 * Returns the odd ROM (planes 0 and 1) and the even one (planes 2 and 3).
 */
export function packNeoCharacters(pixels: Uint8Array): { c1: Uint8Array; c2: Uint8Array } {
  const tiles = Math.ceil(pixels.length / 256);
  const c1 = new Uint8Array(tiles * NEO_TILE_PLANE_BYTES);
  const c2 = new Uint8Array(tiles * NEO_TILE_PLANE_BYTES);
  for (let tile = 0; tile < tiles; tile += 1) {
    const source = tile * 256;
    const target = tile * NEO_TILE_PLANE_BYTES;
    for (let block = 0; block < 4; block += 1) {
      const [originX, originY] = NEO_BLOCK_ORIGINS[block]!;
      for (let row = 0; row < 8; row += 1) {
        let plane0 = 0;
        let plane1 = 0;
        let plane2 = 0;
        let plane3 = 0;
        for (let column = 0; column < 8; column += 1) {
          const value = pixels[source + (originY + row) * 16 + originX + column] ?? 0;
          // The leftmost pixel of the row is the most significant bit.
          const bit = 1 << (7 - column);
          if (value & 1) plane0 |= bit;
          if (value & 2) plane1 |= bit;
          if (value & 4) plane2 |= bit;
          if (value & 8) plane3 |= bit;
        }
        const at = target + block * 16 + row * 2;
        c1[at] = plane0;
        c1[at + 1] = plane1;
        c2[at] = plane2;
        c2[at + 1] = plane3;
      }
    }
  }
  return { c1, c2 };
}

/**
 * Decode a C ROM pair back to one byte a pixel.
 *
 * The inverse of {@link packNeoCharacters}, and the way `@demake/neogeo` is fed:
 * a core handed already-decoded pixels could not catch an encoder that packed
 * the blocks in the wrong order, because nothing would ever have unpacked them.
 */
export function unpackNeoCharacters(c1: Uint8Array, c2: Uint8Array): Uint8Array {
  const tiles = Math.floor(Math.min(c1.length, c2.length) / NEO_TILE_PLANE_BYTES);
  const pixels = new Uint8Array(tiles * 256);
  for (let tile = 0; tile < tiles; tile += 1) {
    const source = tile * NEO_TILE_PLANE_BYTES;
    const target = tile * 256;
    for (let block = 0; block < 4; block += 1) {
      const [originX, originY] = NEO_BLOCK_ORIGINS[block]!;
      for (let row = 0; row < 8; row += 1) {
        const at = source + block * 16 + row * 2;
        const plane0 = c1[at] ?? 0;
        const plane1 = c1[at + 1] ?? 0;
        const plane2 = c2[at] ?? 0;
        const plane3 = c2[at + 1] ?? 0;
        for (let column = 0; column < 8; column += 1) {
          const bit = 7 - column;
          const value =
            (((plane0 >> bit) & 1) << 0) |
            (((plane1 >> bit) & 1) << 1) |
            (((plane2 >> bit) & 1) << 2) |
            (((plane3 >> bit) & 1) << 3);
          pixels[target + (originY + row) * 16 + originX + column] = value;
        }
      }
    }
  }
  return pixels;
}

/**
 * Encode 8×8 fix tiles into the S ROM.
 *
 * `pixels` is one byte a pixel, row-major within each tile, 64 bytes a tile.
 * A byte holds two horizontally adjacent pixels with the **left one in the low
 * nibble**, and the byte's address inside the tile is `H × 16 + C × 8 + row`
 * where `H = 0` is the tile's *right* half.
 */
export function packNeoFix(pixels: Uint8Array): Uint8Array {
  const tiles = Math.ceil(pixels.length / 64);
  const rom = new Uint8Array(tiles * NEO_FIX_TILE_BYTES);
  for (let tile = 0; tile < tiles; tile += 1) {
    const source = tile * 64;
    const target = tile * NEO_FIX_TILE_BYTES;
    for (let half = 0; half < 2; half += 1) {
      // `half` 0 is the right-hand four columns, which are stored first.
      const originX = half === 0 ? 4 : 0;
      for (let pair = 0; pair < 2; pair += 1) {
        for (let row = 0; row < 8; row += 1) {
          const left = pixels[source + row * 8 + originX + pair * 2] ?? 0;
          const right = pixels[source + row * 8 + originX + pair * 2 + 1] ?? 0;
          rom[target + half * 16 + pair * 8 + row] = ((right & 0xf) << 4) | (left & 0xf);
        }
      }
    }
  }
  return rom;
}

/** Decode an S ROM back to one byte a pixel. The inverse of {@link packNeoFix}. */
export function unpackNeoFix(rom: Uint8Array): Uint8Array {
  const tiles = Math.floor(rom.length / NEO_FIX_TILE_BYTES);
  const pixels = new Uint8Array(tiles * 64);
  for (let tile = 0; tile < tiles; tile += 1) {
    const source = tile * NEO_FIX_TILE_BYTES;
    const target = tile * 64;
    for (let half = 0; half < 2; half += 1) {
      const originX = half === 0 ? 4 : 0;
      for (let pair = 0; pair < 2; pair += 1) {
        for (let row = 0; row < 8; row += 1) {
          const byte = rom[source + half * 16 + pair * 8 + row] ?? 0;
          pixels[target + row * 8 + originX + pair * 2] = byte & 0xf;
          pixels[target + row * 8 + originX + pair * 2 + 1] = byte >> 4;
        }
      }
    }
  }
  return pixels;
}

/** What the cartridge header records about the game. */
export interface NeoHeaderOptions {
  /** The NGH number, in BCD. Zero is prohibited by the format. */
  ngh?: number;
  /** Up to 33 characters, for the container's catalogue entry. */
  name?: string;
  /** The vertical-blank handler's address, for the vector at `$0064`. */
  vblank: number;
  /** The game's entry point, which the header's `JMP USER` targets. */
  user: number;
  /** The initial stack pointer, taken from the image's first longword. */
  stack: number;
}

/**
 * Build the first {@link NEO_CODE_ORIGIN} bytes of a P ROM: vectors and header.
 *
 * The 68000's own vectors come first — stack pointer at `$0000`, reset at
 * `$0004`, and vertical blank at `$0064`, which is interrupt level 1's
 * autovector and *not* the level 6 a Mega Drive uses. Then the console's header
 * at `$0100`: the `NEO-GEO` string the hardware recognises a cartridge by, the
 * NGH number, the P ROM's size, and the jump table whose first entry is the
 * `USER` the boot hand-off enters through.
 *
 * The reset vector points at `USER` too. On a real board it would point into the
 * system ROM, which would then call back through this table; a demade cartridge
 * needs nothing the system ROM does, so pointing it at the same place makes the
 * image self-contained without changing what the documented hand-off reaches.
 */
export function packNeoHeader(size: number, options: NeoHeaderOptions): Uint8Array {
  const header = new Uint8Array(NEO_CODE_ORIGIN);
  const view = new DataView(header.buffer);
  view.setUint32(0x000, options.stack >>> 0, false);
  view.setUint32(0x004, options.user >>> 0, false);
  view.setUint32(0x064, options.vblank >>> 0, false);

  for (const [index, code] of [..."NEO-GEO"].entries()) {
    header[NEO_HEADER_OFFSET + index] = code.charCodeAt(0);
  }
  header[NEO_HEADER_OFFSET + 0x07] = 0; // System version: 0 is a cartridge.
  view.setUint16(NEO_HEADER_OFFSET + 0x08, options.ngh ?? 0x0001, false);
  view.setUint32(NEO_HEADER_OFFSET + 0x0a, size >>> 0, false);

  // The four entry points, each a six-byte `jmp <abs>.l`. A demade cartridge
  // implements only the first: it takes no coins, ends no demo and starts no
  // second player, so the other three enter the same routine rather than
  // pointing at nothing.
  for (const [index, at] of [0x122, 0x128, 0x12e, 0x134].entries()) {
    void index;
    header[at] = 0x4e;
    header[at + 1] = 0xf9;
    view.setUint32(at + 2, options.user >>> 0, false);
  }
  return header;
}

/** Every region a `.neo` container can carry. */
export interface NeoRegions {
  /** The 68000's program, header included. */
  p: Uint8Array;
  /** Fix layer tiles, already packed by {@link packNeoFix}. */
  s: Uint8Array;
  /** Sprite tiles: the odd ROM of the pair. */
  c1: Uint8Array;
  /** Sprite tiles: the even ROM of the pair. */
  c2: Uint8Array;
}

/**
 * Write the `.neo` container.
 *
 * A 4096-byte header of little-endian region lengths and catalogue text, then
 * P, S, M, V1, V2 and C end to end. The M and V regions are empty here: this
 * build emits no Z80 program, so a board with no sound ROMs is what it
 * describes.
 *
 * **The C region is the pair interleaved a byte at a time**, odd ROM at even
 * offsets. This was the one thing here taken from convention rather than a
 * format description, and it has since been checked against a reference
 * converter — `neosdconv` builds its C region as `interleave(pair, 1)` over
 * `[...oddData, ...evenData]`, which is a one-byte leaf with the odd ROM landing
 * on the even offsets. The same arrangement, arrived at independently.
 */
export function packNeoRom(regions: NeoRegions, options: { name?: string; ngh?: number } = {}) {
  const c = interleave(regions.c1, regions.c2);
  const header = new Uint8Array(NEO_CONTAINER_HEADER);
  const view = new DataView(header.buffer);
  header[0] = 0x4e; // 'N'
  header[1] = 0x45; // 'E'
  header[2] = 0x4f; // 'O'
  header[3] = 0x01; // Format version.
  view.setUint32(0x04, regions.p.length, true);
  view.setUint32(0x08, regions.s.length, true);
  view.setUint32(0x0c, 0, true); // M ROM: no Z80 program.
  view.setUint32(0x10, 0, true); // V1.
  view.setUint32(0x14, 0, true); // V2.
  view.setUint32(0x18, c.length, true);
  view.setUint32(0x28, options.ngh ?? 0x0001, true);
  for (const [index, code] of [...(options.name ?? "demake").slice(0, 32)].entries()) {
    header[0x2c + index] = code.charCodeAt(0);
  }

  const out = new Uint8Array(header.length + regions.p.length + regions.s.length + c.length);
  let at = 0;
  for (const part of [header, regions.p, regions.s, c]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Merge a ROM pair byte by byte, the odd one at even offsets.
 *
 * A one-byte leaf, which is what a reference converter uses; a wider one would
 * produce a container a flash cart reads as scrambled graphics.
 */
function interleave(odd: Uint8Array, even: Uint8Array): Uint8Array {
  const length = Math.max(odd.length, even.length);
  const out = new Uint8Array(length * 2);
  for (let index = 0; index < length; index += 1) {
    out[index * 2] = odd[index] ?? 0;
    out[index * 2 + 1] = even[index] ?? 0;
  }
  return out;
}
