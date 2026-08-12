/**
 * The `neogeo` codegen family — SNK Neo Geo (doc 06).
 *
 * The one family in the set whose "tile" is not the console spec's tile. The
 * layout declares 8×8 at 4bpp because that is what a *pixel* costs here, but the
 * hardware's unit is 16×16: a sprite strip's SCB1 table names 16×16 tiles, and
 * the attribute word that carries a palette belongs to one of those. So this
 * file composes each 2×2 block of language cells into one hardware tile before
 * it dedupes anything — which is exactly what the spec's `attribute: 16×16`
 * already says, and what `neogeo-art.ts` does one layer up for a game's art.
 *
 * That composition is done by asking {@link extractTiles} for 16×16 tiles rather
 * than by writing a second extractor: the palette lookup it performs is per
 * attribute cell, and an attribute cell here *is* a hardware tile, so the
 * synthetic layout below produces the right tiles, the right flips and the right
 * palette in one pass.
 *
 * Three things it emits are this console's rather than a neighbour's.
 *
 *   - **Tiles are a ROM pair, not a bank.** The video hardware reads pixels from
 *     the cartridge's C ROM, so there is nothing to upload and the two artifacts
 *     are the two chips on the board — `.c1.bin` (planes 0 and 1) and `.c2.bin`
 *     (planes 2 and 3). {@link packNeoCharacters} is where the format's one
 *     genuine surprise lives: a tile's four 8×8 blocks are stored right half
 *     before left.
 *   - **The map is a display list, and it is still two words a cell.** SCB1
 *     stores a tile number and an attribute word per row of a strip, so a
 *     `.map.bin` of `(tile, attribute)` pairs in row-major cell order is exactly
 *     what a runtime streams into VRAM — the same shape a Sega name table or a
 *     PC Engine BAT takes, reached by hardware with no tilemap in it at all.
 *   - **A palette word is `dark | lsbRGB | R4 G4 B4`.** Five bits a channel,
 *     assembled high-nibble first with the three least significant bits gathered
 *     into 14–12, and the dark bit written as zero for the reason
 *     `@demake/neogeo`'s `expandColor` states — its position is documented and
 *     its sense is not.
 *
 * `asm` targets the GNU m68k assembler, which is what the display-ROM harness
 * uses and the only assembler this project shells out to for this processor.
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import { packNeoCharacters } from "../asm/neo-cart.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

/** Pixels a hardware tile is on a side. A language cell is a quarter of one. */
export const NEO_HW_TILE = 16;

/** Colours in one sub-palette. */
const PALETTE_SIZE = 16;

interface NeoData {
  tiled: TiledData;
  /** One byte a pixel, 256 a tile — the form {@link packNeoCharacters} takes. */
  pixels: Uint8Array;
  c1: Uint8Array;
  c2: Uint8Array;
  /** Two big-endian words a cell: the tile number, then SCB1's attribute. */
  mapBytes: Uint8Array;
  /** Big-endian palette words, sixteen to a sub-palette. */
  palBytes: Uint8Array;
  palettes: number;
}

/**
 * One palette word.
 *
 * Bit 15 is the dark bit and is left clear; bits 14–12 are red's, green's and
 * blue's least significant bits; bits 11–0 are their four high bits in that
 * order. A shared least significant bit is what makes five the honest lattice
 * (`consoles/neogeo.ts`), so a code here is 0–31 and splits four-and-one.
 */
export function neoColorWord(codes: readonly number[]): number {
  const r = (codes[0] ?? 0) & 0x1f;
  const g = (codes[1] ?? 0) & 0x1f;
  const b = (codes[2] ?? 0) & 0x1f;
  return (
    ((r & 1) << 14) |
    ((g & 1) << 13) |
    ((b & 1) << 12) |
    ((r >> 1) << 8) |
    ((g >> 1) << 4) |
    (b >> 1)
  );
}

/** SCB1's odd word: the palette, the tile number's high bits, and the flips. */
function attributeWord(palette: number, tile: number, xflip: boolean, yflip: boolean): number {
  return ((palette & 0xff) << 8) | (((tile >> 16) & 0xf) << 4) | (yflip ? 2 : 0) | (xflip ? 1 : 0);
}

function buildNeoData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): NeoData {
  const layout = spec.layout as TileLayout;
  // The hardware's tile, not the language's — see this file's header.
  const tiled = extractTiles(img, layout, { w: NEO_HW_TILE, h: NEO_HW_TILE });

  const pixels = new Uint8Array(tiled.tiles.length * NEO_HW_TILE * NEO_HW_TILE);
  tiled.tiles.forEach((grid, i) => pixels.set(grid, i * NEO_HW_TILE * NEO_HW_TILE));
  const { c1, c2 } = packNeoCharacters(pixels);

  const mapBytes = new Uint8Array(tiled.map.length * 4);
  const view = new DataView(mapBytes.buffer);
  tiled.map.forEach((ref, i) => {
    const tile = opts.tileBase + ref.tile;
    view.setUint16(i * 4, tile & 0xffff, false);
    view.setUint16(
      i * 4 + 2,
      attributeWord(tiled.cellPalette[i]!, tile, ref.xflip, ref.yflip),
      false,
    );
  });

  // Every sub-palette the fit used, in order. Colour 0 is transparent on this
  // hardware, so it is emitted as the fit left it and what shows through is the
  // backdrop — which is the *last* entry of the bank and a runtime's to write.
  const palettes = Math.max(1, img.palettes.length);
  const palBytes = new Uint8Array(palettes * PALETTE_SIZE * 2);
  const palView = new DataView(palBytes.buffer);
  for (let p = 0; p < palettes; p += 1) {
    const colors = img.palettes[p]?.colors ?? [];
    for (let c = 0; c < PALETTE_SIZE; c += 1) {
      palView.setUint16((p * PALETTE_SIZE + c) * 2, neoColorWord(colors[c]?.codes ?? []), false);
    }
  }

  return { tiled, pixels, c1, c2, mapBytes, palBytes, palettes };
}

function emitBin(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildNeoData(img, spec, opts);
  return [
    { suffix: ".c1.bin", kind: "bin", bytes: d.c1 },
    { suffix: ".c2.bin", kind: "bin", bytes: d.c2 },
    { suffix: ".map.bin", kind: "bin", bytes: d.mapBytes },
    { suffix: ".pal.bin", kind: "bin", bytes: d.palBytes },
  ];
}

/** A GNU-as `.byte` list, which is what this family's harness assembles. */
function byteList(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    lines.push(
      "    .byte " + Array.from(bytes.slice(i, i + perLine), (b) => `0x${hex2(b)}`).join(", "),
    );
  }
  return lines.length ? lines.join("\n") : "    | (none)";
}

function emitAsm(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildNeoData(img, spec, opts);
  const sym = opts.symbol;
  const out = [opts.header.map((l) => `| ${l}`).join("\n"), ""];
  out.push(`    .set ${sym}_TILE_COUNT, ${d.tiled.tiles.length}`);
  out.push(`    .set ${sym}_MAP_W, ${d.tiled.tilesX}`, `    .set ${sym}_MAP_H, ${d.tiled.tilesY}`);
  out.push(`    .set ${sym}_PAL_COUNT, ${d.palettes}`, "");
  out.push(`${sym}_c1:`, byteList(d.c1), "");
  out.push(`${sym}_c2:`, byteList(d.c2), "");
  out.push(`${sym}_map:`, byteList(d.mapBytes), "");
  out.push(`${sym}_pal:`, byteList(d.palBytes), "");
  return [{ suffix: ".s", kind: "asm", bytes: asciiBytes(out.join("\n") + "\n") }];
}

function cArray(name: string, bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push("    " + Array.from(bytes.slice(i, i + 16), (b) => `0x${hex2(b)}`).join(", ") + ",");
  }
  return `const unsigned char ${name}[${bytes.length}] = {\n${lines.join("\n")}\n};\n`;
}

function emitC(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildNeoData(img, spec, opts);
  const sym = opts.symbol;
  const comment = "/*\n" + opts.header.map((l) => ` * ${l}`).join("\n") + "\n */\n";
  const c = [
    comment,
    cArray(`${sym}_c1`, d.c1),
    cArray(`${sym}_c2`, d.c2),
    cArray(`${sym}_map`, d.mapBytes),
    cArray(`${sym}_palette`, d.palBytes),
  ].join("\n");
  const guard = sym.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_H";
  const h = [
    comment,
    `#ifndef ${guard}`,
    `#define ${guard}`,
    `#define ${sym}_TILE_COUNT ${d.tiled.tiles.length}`,
    `#define ${sym}_MAP_W ${d.tiled.tilesX}`,
    `#define ${sym}_MAP_H ${d.tiled.tilesY}`,
    `#define ${sym}_PAL_COUNT ${d.palettes}`,
    `extern const unsigned char ${sym}_c1[${d.c1.length}];`,
    `extern const unsigned char ${sym}_c2[${d.c2.length}];`,
    `extern const unsigned char ${sym}_map[${d.mapBytes.length}];`,
    `extern const unsigned char ${sym}_palette[${d.palBytes.length}];`,
    `#endif`,
    "",
  ].join("\n");
  return [
    { suffix: ".c", kind: "c", bytes: asciiBytes(c) },
    { suffix: ".h", kind: "header", bytes: asciiBytes(h) },
  ];
}

/** The `neogeo` family backend. */
export const neogeoBackend: CodegenBackend = {
  family: "neogeo",
  emitBin,
  emitAsm,
  emitC,
};
