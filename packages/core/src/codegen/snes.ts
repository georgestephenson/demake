/**
 * The `snes` codegen family — Super Nintendo / Super Famicom (doc 06).
 *
 * Emits Mode-1 background structures: 4bpp SNES tiles (32 bytes each — planes
 * 0/1 interleaved per row, then planes 2/3), a 2-byte-per-entry tilemap word
 * (V/H flip, priority, 3-bit palette select, 10-bit tile index, little-endian for
 * the 65816), and eight 16-color CGRAM sub-palettes in BGR555. Color 0 of every
 * palette is the shared transparent backdrop shown through the BG — the same
 * shared-index-0 machinery the MD backdrop uses, and CGRAM entry 0 is that same
 * color so a transparent pixel reproduces it exactly. `asm` targets WLA-DX
 * (wla-65816).
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, packSnes4, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

interface SnesData {
  tiled: TiledData;
  tileBytes: Uint8Array;
  mapBytes: Uint8Array; // 2 bytes/entry, little-endian tilemap words
  palBytes: Uint8Array; // 8 × 16 × 2 bytes, little-endian BGR555 words
}

/** One CGRAM word: 0BBBBBGG GGGRRRRR, little-endian (low byte first). */
function colorBytes(codes: readonly number[]): [number, number] {
  const r = (codes[0] ?? 0) & 31;
  const g = (codes[1] ?? 0) & 31;
  const b = (codes[2] ?? 0) & 31;
  const word = (b << 10) | (g << 5) | r;
  return [word & 0xff, (word >> 8) & 0xff];
}

function buildSnesData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): SnesData {
  const layout = spec.layout as TileLayout;
  const tiled = extractTiles(img, layout);

  const tileBytes = new Uint8Array(tiled.tiles.length * 32);
  tiled.tiles.forEach((grid, i) => {
    tileBytes.set(packSnes4(grid, tiled.tileW, tiled.tileH), i * 32);
  });

  // Tilemap: vhopppcc cccccccc — priority 0, palette from the attribute cell.
  const mapBytes = new Uint8Array(tiled.map.length * 2);
  tiled.map.forEach((ref, i) => {
    const tile = (opts.tileBase + ref.tile) & 0x3ff;
    const word =
      tile |
      ((tiled.cellPalette[i]! & 7) << 10) |
      ((ref.xflip ? 1 : 0) << 14) |
      ((ref.yflip ? 1 : 0) << 15);
    mapBytes[i * 2] = word & 0xff;
    mapBytes[i * 2 + 1] = (word >> 8) & 0xff;
  });

  // Eight 16-color sub-palettes; color 0 everywhere is the shared backdrop, and
  // CGRAM 0 (this same color) is what a transparent BG pixel shows.
  const count = layout.subPalettes.count;
  const size = layout.subPalettes.size;
  const pal = new Uint8Array(count * size * 2);
  const backdrop = img.palettes[0]?.colors[0]?.codes ?? [0, 0, 0];
  for (let p = 0; p < count; p += 1) {
    const colors = img.palettes[p]?.colors ?? [];
    for (let c = 0; c < size; c += 1) {
      const codes = c === 0 ? backdrop : (colors[c]?.codes ?? backdrop);
      const [lo, hi] = colorBytes(codes);
      pal[(p * size + c) * 2] = lo;
      pal[(p * size + c) * 2 + 1] = hi;
    }
  }

  return { tiled, tileBytes, mapBytes, palBytes: pal };
}

function emitBin(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildSnesData(img, spec, opts);
  return [
    { suffix: ".tiles.bin", kind: "bin", bytes: d.tileBytes },
    { suffix: ".map.bin", kind: "bin", bytes: d.mapBytes },
    { suffix: ".pal.bin", kind: "bin", bytes: d.palBytes },
  ];
}

/** WLA-DX `.db` list. */
function dbList(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    lines.push(".db " + Array.from(bytes.slice(i, i + perLine), (b) => `$${hex2(b)}`).join(", "));
  }
  return lines.length ? lines.join("\n") : "; (none)";
}

function emitAsm(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildSnesData(img, spec, opts);
  const sym = opts.symbol;
  const out = [opts.header.map((l) => `; ${l}`).join("\n"), ""];
  out.push(`${sym}_tiles:`, dbList(d.tileBytes));
  out.push(`.define ${sym}_TILE_COUNT ${d.tiled.tiles.length}`, "");
  out.push(`${sym}_map:`, dbList(d.mapBytes));
  out.push(`.define ${sym}_MAP_W ${d.tiled.tilesX}`, `.define ${sym}_MAP_H ${d.tiled.tilesY}`, "");
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
  const d = buildSnesData(img, spec, opts);
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

/** The `snes` family backend (Super Nintendo / Super Famicom, Mode 1 BG). */
export const snesBackend: CodegenBackend = {
  family: "snes",
  emitBin,
  emitAsm,
  emitC,
};
