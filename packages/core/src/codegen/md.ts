/**
 * The `md` codegen family — Sega Mega Drive / Genesis (doc 06).
 *
 * Emits VDP background structures: 4bpp **row-major packed** tiles (32 bytes
 * each, left pixel in the high nibble), a 2-byte-per-entry plane map (the VDP
 * cell word: priority, 2-bit palette select, V/H flip, 11-bit tile index — stored
 * big-endian for the m68k), and four 16-color CRAM sub-palettes in BGR333. Color 0
 * of every palette is the shared transparent backdrop (VDP register 7 points at
 * it), the same shared-index-0 machinery the NES backdrop uses. `asm` targets
 * vasm (Motorola syntax).
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, packPacked4, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

interface MdData {
  tiled: TiledData;
  tileBytes: Uint8Array;
  mapBytes: Uint8Array; // 2 bytes/entry, big-endian VDP cell words
  palBytes: Uint8Array; // 4 × 16 × 2 bytes, big-endian BGR333 words
}

/** One BGR333 CRAM word: 0000 BBB0 GGG0 RRR0, big-endian (high byte first). */
function colorBytes(codes: readonly number[]): [number, number] {
  const r = (codes[0] ?? 0) & 7;
  const g = (codes[1] ?? 0) & 7;
  const b = (codes[2] ?? 0) & 7;
  const word = (b << 9) | (g << 5) | (r << 1);
  return [(word >> 8) & 0xff, word & 0xff];
}

function buildMdData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): MdData {
  const layout = spec.layout as TileLayout;
  const tiled = extractTiles(img, layout);

  // Tile 0 is reserved blank/transparent — the Mega Drive convention. A pixel of
  // color index 0 is transparent and reveals the plane behind; leaving the second
  // scroll plane pointing at tile 0 (its cleared default) then shows the backdrop,
  // never stray pattern data. Real tiles therefore start at index 1.
  const tileBytes = new Uint8Array((tiled.tiles.length + 1) * 32);
  tiled.tiles.forEach((grid, i) => {
    tileBytes.set(packPacked4(grid, tiled.tileW, tiled.tileH), (i + 1) * 32);
  });

  // Plane map: one VDP cell word per position (priority 0), big-endian.
  const mapBytes = new Uint8Array(tiled.map.length * 2);
  tiled.map.forEach((ref, i) => {
    const tile = (opts.tileBase + ref.tile + 1) & 0x7ff;
    const pal = (tiled.cellPalette[i]! & 3) << 13;
    const word = tile | pal | ((ref.yflip ? 1 : 0) << 12) | ((ref.xflip ? 1 : 0) << 11);
    mapBytes[i * 2] = (word >> 8) & 0xff;
    mapBytes[i * 2 + 1] = word & 0xff;
  });

  // Four 16-color sub-palettes, color 0 the shared transparent backdrop.
  const pal = new Uint8Array(4 * 16 * 2);
  const backdrop = img.palettes[0]?.colors[0]?.codes ?? [0, 0, 0];
  for (let p = 0; p < 4; p += 1) {
    const colors = img.palettes[p]?.colors ?? [];
    for (let c = 0; c < 16; c += 1) {
      const codes = c === 0 ? backdrop : (colors[c]?.codes ?? backdrop);
      const [hi, lo] = colorBytes(codes);
      pal[(p * 16 + c) * 2] = hi;
      pal[(p * 16 + c) * 2 + 1] = lo;
    }
  }

  return { tiled, tileBytes, mapBytes, palBytes: pal };
}

function emitBin(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildMdData(img, spec, opts);
  return [
    { suffix: ".tiles.bin", kind: "bin", bytes: d.tileBytes },
    { suffix: ".map.bin", kind: "bin", bytes: d.mapBytes },
    { suffix: ".pal.bin", kind: "bin", bytes: d.palBytes },
  ];
}

/** vasm/Motorola `dc.b` list. */
function dcList(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    lines.push(
      "    dc.b " + Array.from(bytes.slice(i, i + perLine), (b) => `$${hex2(b)}`).join(","),
    );
  }
  return lines.length ? lines.join("\n") : "    ; (none)";
}

function emitAsm(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildMdData(img, spec, opts);
  const sym = opts.symbol;
  const out = [opts.header.map((l) => `; ${l}`).join("\n"), ""];
  out.push(`${sym}_TILE_COUNT equ ${d.tileBytes.length / 32}`);
  out.push(`${sym}_MAP_W equ ${d.tiled.tilesX}`, `${sym}_MAP_H equ ${d.tiled.tilesY}`, "");
  out.push(`${sym}_tiles:`, dcList(d.tileBytes), "");
  out.push(`${sym}_map:`, dcList(d.mapBytes), "");
  out.push(`${sym}_pal:`, dcList(d.palBytes), "");
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
  const d = buildMdData(img, spec, opts);
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
    `#define ${sym}_TILE_COUNT ${d.tileBytes.length / 32}`,
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

/** The `md` family backend (Sega Mega Drive / Genesis). */
export const mdBackend: CodegenBackend = {
  family: "md",
  emitBin,
  emitAsm,
  emitC,
};
