/**
 * The `wsc` codegen family — Bandai WonderSwan Color (doc 06).
 *
 * Emits the display controller's colour-mode background structures: 4bpp
 * **row-major packed** tiles (32 bytes each, left pixel in the high nibble —
 * the "packed"/Genesis-like tile format selected by video mode `$60 = $E0`), a
 * 2-byte-per-entry screen map word (9-bit tile number, 4-bit palette select,
 * tile bank, H/V flip — little-endian for the V30MZ), and 16 sixteen-colour
 * palettes as RGB444 words. Colour 0 of every palette is transparent and shows
 * the backdrop the display picks with port `$01`, so it is emitted as the shared
 * backdrop — the same shared-index-0 machinery the Mega Drive and SNES backends
 * use. `asm` targets NASM (16-bit x86, the V30MZ's instruction set).
 *
 * The mono WonderSwan is deliberately *not* this family: its tiles are 2bpp and
 * its palettes are shade-pool indices, not colour words (doc 03).
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, packPacked4, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

/** Palettes the display controller gives the background layer, and their size. */
const PALETTES = 16;
const PALETTE_SIZE = 16;

interface WscData {
  tiled: TiledData;
  tileBytes: Uint8Array;
  mapBytes: Uint8Array; // 2 bytes per entry, little-endian screen words
  palBytes: Uint8Array; // 16 × 16 × 2 bytes, little-endian RGB444 words
}

/** One palette word: `0000RRRR GGGGBBBB`, little-endian byte pair. */
function colorBytes(codes: readonly number[]): [number, number] {
  const r = (codes[0] ?? 0) & 0xf;
  const g = (codes[1] ?? 0) & 0xf;
  const b = (codes[2] ?? 0) & 0xf;
  const word = (r << 8) | (g << 4) | b;
  return [word & 0xff, (word >> 8) & 0xff];
}

function buildWscData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): WscData {
  const layout = spec.layout as TileLayout;
  const tiled = extractTiles(img, layout);

  const tileBytes = new Uint8Array(tiled.tiles.length * 32);
  tiled.tiles.forEach((grid, i) => {
    tileBytes.set(packPacked4(grid, tiled.tileW, tiled.tileH), i * 32);
  });

  // Screen map: 9-bit tile number + bank bit (the controller holds two banks of
  // 512 tiles), 4-bit palette select, H flip at bit 14 and V flip at bit 15.
  const mapBytes = new Uint8Array(tiled.map.length * 2);
  tiled.map.forEach((ref, i) => {
    const tile = opts.tileBase + ref.tile;
    const word =
      (tile & 0x1ff) |
      ((tiled.cellPalette[i]! & 0xf) << 9) |
      (((tile >> 9) & 1) << 13) |
      ((ref.xflip ? 1 : 0) << 14) |
      ((ref.yflip ? 1 : 0) << 15);
    mapBytes[i * 2] = word & 0xff;
    mapBytes[i * 2 + 1] = (word >> 8) & 0xff;
  });

  // 16 palettes; colour 0 of each is transparent, so it carries the backdrop.
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
  const d = buildWscData(img, spec, opts);
  return [
    { suffix: ".tiles.bin", kind: "bin", bytes: d.tileBytes },
    { suffix: ".map.bin", kind: "bin", bytes: d.mapBytes },
    { suffix: ".pal.bin", kind: "bin", bytes: d.palBytes },
  ];
}

/** NASM `db` list. */
function dbList(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    lines.push(
      "    db " + Array.from(bytes.slice(i, i + perLine), (b) => `0x${hex2(b)}`).join(", "),
    );
  }
  return lines.length ? lines.join("\n") : "    ; (none)";
}

function emitAsm(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildWscData(img, spec, opts);
  const sym = opts.symbol;
  const out = [opts.header.map((l) => `; ${l}`).join("\n"), ""];
  out.push(`%define ${sym}_TILE_COUNT ${d.tiled.tiles.length}`);
  out.push(`%define ${sym}_MAP_W ${d.tiled.tilesX}`, `%define ${sym}_MAP_H ${d.tiled.tilesY}`, "");
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
  const d = buildWscData(img, spec, opts);
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

/** The `wsc` family backend (WonderSwan Color). */
export const wscBackend: CodegenBackend = {
  family: "wsc",
  emitBin,
  emitAsm,
  emitC,
};
