/**
 * The `ngpc` codegen family — SNK Neo Geo Pocket Color (doc 06).
 *
 * Emits the K2GE's background structures: 2bpp characters as sixteen bytes each
 * (a row is a little-endian halfword with the leftmost pixel in the highest two
 * bits — see {@link packPacked2Word}), a two-byte scroll-plane map word, and the
 * palette block as RGB444 words.
 *
 * Three things about the map word are this chip's rather than a neighbour's.
 * There are **nine bits of tile and no bank bit**, because the character bank is
 * five hundred and twelve tiles and that is all of it. The **palette field is
 * four bits at bit 9**, which is the WonderSwan's position reached by different
 * hardware, and bit 13 beside it is the *mono* machine's palette select — a
 * K2GE ignores it, and a K1GE ignores the four. And the **flips are the other
 * way round** from the WonderSwan's: vertical at bit 14, horizontal at bit 15.
 *
 * The palette word is **BGR**444 rather than RGB — see {@link colorBytes}.
 *
 * Colour 0 of every palette is transparent and shows whatever is behind the
 * layer, so it is emitted as the shared backdrop — the same shared-index-0
 * machinery the Mega Drive, SNES and WonderSwan backends use. `asm` targets the
 * TLCS-900/H, which is `@demake/core`'s own assembler rather than a third-party
 * one, so the listing is a `db` list a build assembles rather than a source file
 * anybody else's tool reads.
 *
 * The mono Neo Geo Pocket is deliberately *not* this family: its palettes are
 * three-bit shade numbers in eight-entry lookup tables, not colour words.
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, packPacked2Word, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

/** Palettes one layer gets, and how many colours are in each. */
const PALETTES = 16;
const PALETTE_SIZE = 4;

/** Bytes one 8×8 character at 2bpp occupies. */
const TILE_BYTES = 16;

interface NgpcData {
  tiled: TiledData;
  tileBytes: Uint8Array;
  mapBytes: Uint8Array; // 2 bytes per entry, little-endian map words
  palBytes: Uint8Array; // 16 × 4 × 2 bytes, little-endian RGB444 words
}

/**
 * One palette word: `0000BBBB GGGGRRRR`, little-endian byte pair.
 *
 * **Blue first.** This is the only RGB444 console in the set whose palette word
 * runs the other way — red is the low nibble and blue the high one — and it is
 * the single easiest thing about this hardware to get wrong in a way nothing
 * catches, because an encoder and a renderer that agreed with each other would
 * produce a picture in exactly the wrong colours and pass every byte comparison
 * there is.
 */
function colorBytes(codes: readonly number[]): [number, number] {
  const r = (codes[0] ?? 0) & 0xf;
  const g = (codes[1] ?? 0) & 0xf;
  const b = (codes[2] ?? 0) & 0xf;
  const word = (b << 8) | (g << 4) | r;
  return [word & 0xff, (word >> 8) & 0xff];
}

function buildNgpcData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): NgpcData {
  const layout = spec.layout as TileLayout;
  const tiled = extractTiles(img, layout);

  const tileBytes = new Uint8Array(tiled.tiles.length * TILE_BYTES);
  tiled.tiles.forEach((grid, i) => {
    tileBytes.set(packPacked2Word(grid, tiled.tileW, tiled.tileH), i * TILE_BYTES);
  });

  // The map word: nine bits of tile, four of palette at bit 9, V flip at bit 14
  // and H flip at bit 15. Bit 13 is the mono machine's palette select and stays
  // clear, because a colour build is the only thing this family emits.
  const mapBytes = new Uint8Array(tiled.map.length * 2);
  tiled.map.forEach((ref, i) => {
    const tile = opts.tileBase + ref.tile;
    const word =
      (tile & 0x1ff) |
      ((tiled.cellPalette[i]! & 0xf) << 9) |
      ((ref.yflip ? 1 : 0) << 14) |
      ((ref.xflip ? 1 : 0) << 15);
    mapBytes[i * 2] = word & 0xff;
    mapBytes[i * 2 + 1] = (word >> 8) & 0xff;
  });

  // Sixteen palettes of four; colour 0 of each is transparent, so it carries the
  // backdrop rather than whatever the fit left there.
  const pal = new Uint8Array(PALETTES * PALETTE_SIZE * 2);
  const backdrop = img.palettes[0]?.colors[0]?.codes ?? [0, 0, 0];
  for (let p = 0; p < PALETTES; p += 1) {
    const colors = img.palettes[p]?.colors ?? [];
    for (let c = 0; c < PALETTE_SIZE; c += 1) {
      const codes = c === 0 ? backdrop : (colors[c]?.codes ?? backdrop);
      const [lo, hi] = colorBytes(codes);
      pal[(p * PALETTE_SIZE + c) * 2] = lo;
      pal[(p * PALETTE_SIZE + c) * 2 + 1] = hi;
    }
  }

  return { tiled, tileBytes, mapBytes, palBytes: pal };
}

function emitBin(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildNgpcData(img, spec, opts);
  return [
    { suffix: ".tiles.bin", kind: "bin", bytes: d.tileBytes },
    { suffix: ".map.bin", kind: "bin", bytes: d.mapBytes },
    { suffix: ".pal.bin", kind: "bin", bytes: d.palBytes },
  ];
}

/** A `db` list in the syntax this project's own TLCS-900 listings use. */
function dbList(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    lines.push(
      "    db " + Array.from(bytes.slice(i, i + perLine), (b) => `$${hex2(b)}`).join(", "),
    );
  }
  return lines.length ? lines.join("\n") : "    ; (none)";
}

function emitAsm(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildNgpcData(img, spec, opts);
  const sym = opts.symbol;
  const out = [opts.header.map((l) => `; ${l}`).join("\n"), ""];
  out.push(`${sym}_TILE_COUNT equ ${d.tiled.tiles.length}`);
  out.push(`${sym}_MAP_W equ ${d.tiled.tilesX}`, `${sym}_MAP_H equ ${d.tiled.tilesY}`, "");
  out.push(`${sym}_tiles:`, dbList(d.tileBytes), "");
  out.push(`${sym}_map:`, dbList(d.mapBytes), "");
  out.push(`${sym}_pal:`, dbList(d.palBytes), "");
  return [{ suffix: ".asm", kind: "asm", bytes: asciiBytes(out.join("\n") + "\n") }];
}

function cArray(name: string, bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push("    " + Array.from(bytes.slice(i, i + 16), (b) => `0x${hex2(b)}`).join(", ") + ",");
  }
  return `const unsigned char ${name}[${bytes.length}] = {\n${lines.join("\n")}\n};\n`;
}

function emitC(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildNgpcData(img, spec, opts);
  const sym = opts.symbol;
  const comment = "/*\n" + opts.header.map((l) => ` * ${l}`).join("\n") + "\n */\n";
  const c = [
    comment,
    cArray(`${sym}_tiles`, d.tileBytes),
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
    `extern const unsigned char ${sym}_tiles[${d.tileBytes.length}];`,
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

/** The `ngpc` family backend (Neo Geo Pocket Color). */
export const ngpcBackend: CodegenBackend = {
  family: "ngpc",
  emitBin,
  emitAsm,
  emitC,
};
