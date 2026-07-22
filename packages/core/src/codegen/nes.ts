/**
 * The `nes` codegen family (doc 06 §Per-family backends).
 *
 * Emits the four NES background structures: 2bpp **plane-grouped** CHR pattern
 * data, a nametable of tile indices, a packed **attribute table** (2 bits of
 * palette per 16×16 cell, four cells per byte), and a 16-byte palette of master
 * indices with the shared backdrop at $3F00. `asm` targets ca65; `c` targets
 * cc65/NROM projects. The NES background has no tile flip, so dedup is exact.
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, packPlaneGrouped, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

/** NES data derived once, formatted three ways. */
interface NesData {
  tiled: TiledData;
  chr: Uint8Array;
  nametable: Uint8Array;
  attribute: Uint8Array;
  palette: Uint8Array;
  cellsX: number;
  cellsY: number;
}

/** Pack per-16×16-cell palette numbers into the 64-byte NES attribute table. */
function attributeTable(img: CompliantImage): Uint8Array {
  const { cellsX, cellsY } = img.grid;
  const attr = new Uint8Array(64); // 8×8 blocks of 32×32 px
  for (let cy = 0; cy < cellsY; cy += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      const pal = img.cellPalette[cy * cellsX + cx]! & 0x03;
      const blockX = cx >> 1;
      const blockY = cy >> 1;
      const quadrant = (cy & 1) * 2 + (cx & 1); // 0=TL 1=TR 2=BL 3=BR
      attr[blockY * 8 + blockX]! |= pal << (quadrant * 2);
    }
  }
  return attr;
}

/** The 16-byte NES palette: backdrop at 0/4/8/12, three colors per sub-palette. */
function paletteBytes(img: CompliantImage): Uint8Array {
  const out = new Uint8Array(16);
  const backdrop = img.palettes[0]?.colors[0]?.codes[0] ?? 0;
  for (let p = 0; p < 4; p += 1) {
    out[p * 4] = backdrop;
    const colors = img.palettes[p]?.colors ?? [];
    for (let c = 1; c < 4; c += 1) out[p * 4 + c] = colors[c]?.codes[0] ?? backdrop;
  }
  return out;
}

function buildNesData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): NesData {
  const layout = spec.layout as TileLayout;
  const tiled = extractTiles(img, layout);

  const chr = new Uint8Array(tiled.tiles.length * 16);
  tiled.tiles.forEach((grid, i) => {
    chr.set(packPlaneGrouped(grid, tiled.tileW, tiled.tileH, tiled.bpp), i * 16);
  });

  const nametable = new Uint8Array(tiled.map.length);
  for (let i = 0; i < tiled.map.length; i += 1) {
    nametable[i] = (opts.tileBase + tiled.map[i]!.tile) & 0xff;
  }

  return {
    tiled,
    chr,
    nametable,
    attribute: attributeTable(img),
    palette: paletteBytes(img),
    cellsX: img.grid.cellsX,
    cellsY: img.grid.cellsY,
  };
}

function emitBin(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildNesData(img, spec, opts);
  return [
    { suffix: ".chr.bin", kind: "bin", bytes: d.chr },
    { suffix: ".nam.bin", kind: "bin", bytes: d.nametable },
    { suffix: ".attr.bin", kind: "bin", bytes: d.attribute },
    { suffix: ".pal.bin", kind: "bin", bytes: d.palette },
  ];
}

function dbList(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    const slice = Array.from(bytes.slice(i, i + perLine), (b) => `$${hex2(b)}`);
    lines.push("    .byte " + slice.join(", "));
  }
  return lines.length ? lines.join("\n") : "    ; (none)";
}

function emitAsm(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildNesData(img, spec, opts);
  const sym = opts.symbol;
  const out: string[] = [opts.header.map((l) => `; ${l}`).join("\n"), ""];
  out.push(`.export _${sym}_chr, _${sym}_nam, _${sym}_attr, _${sym}_pal`, "");
  out.push(`_${sym}_chr:`, dbList(d.chr));
  out.push(`${sym}_CHR_TILES = ${d.tiled.tiles.length}`, "");
  out.push(`_${sym}_nam:`, dbList(d.nametable));
  out.push(`${sym}_MAP_W = ${d.tiled.tilesX}`, `${sym}_MAP_H = ${d.tiled.tilesY}`, "");
  out.push(`_${sym}_attr:`, dbList(d.attribute), "");
  out.push(`_${sym}_pal:`, dbList(d.palette), "");
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
  const d = buildNesData(img, spec, opts);
  const sym = opts.symbol;
  const guard = sym.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_H";
  const comment = "/*\n" + opts.header.map((l) => ` * ${l}`).join("\n") + "\n */\n";

  const c = [
    comment,
    `#include "${sym}.h"`,
    "",
    cArray(`${sym}_chr`, d.chr),
    cArray(`${sym}_nametable`, d.nametable),
    cArray(`${sym}_attribute`, d.attribute),
    cArray(`${sym}_palette`, d.palette),
  ].join("\n");

  const h = [
    comment,
    `#ifndef ${guard}`,
    `#define ${guard}`,
    "",
    `#define ${sym}_CHR_TILES ${d.tiled.tiles.length}`,
    `#define ${sym}_MAP_W ${d.tiled.tilesX}`,
    `#define ${sym}_MAP_H ${d.tiled.tilesY}`,
    `extern const unsigned char ${sym}_chr[${d.chr.length}];`,
    `extern const unsigned char ${sym}_nametable[${d.nametable.length}];`,
    `extern const unsigned char ${sym}_attribute[${d.attribute.length}];`,
    `extern const unsigned char ${sym}_palette[${d.palette.length}];`,
    "",
    `#endif /* ${guard} */`,
    "",
  ].join("\n");

  return [
    { suffix: ".c", kind: "c", bytes: asciiBytes(c) },
    { suffix: ".h", kind: "header", bytes: asciiBytes(h) },
  ];
}

/** The `nes` family backend. */
export const nesBackend: CodegenBackend = {
  family: "nes",
  emitBin,
  emitAsm,
  emitC,
};
