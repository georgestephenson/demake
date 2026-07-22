/**
 * The `gb` codegen family — DMG + GBC (doc 06 §Per-family backends).
 *
 * Emits planar 2bpp tiles, a BG tile map, and — driven purely by the console
 * spec — either a monochrome BGP register (DMG) or BGR555 sub-palettes plus a
 * CGB attribute map (GBC). The `asm` form is idiomatic RGBDS, including the
 * backtick 2bpp graphics rows `gen-portraits.py` used; the `c` form targets
 * GBDK. All three formats describe the *same* deduplicated data.
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, packPlanar, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

/** GB shared data derived once, then formatted three ways. */
interface GbData {
  color: boolean;
  tiled: TiledData;
  /** Planar 2bpp tile bytes (16 per tile), concatenated. */
  tileBytes: Uint8Array;
  /** One BG-map byte per cell (`tileBase + tile`, low byte). */
  mapBytes: Uint8Array;
  /** GBC: one CGB attribute byte per cell. Empty on DMG. */
  attrBytes: Uint8Array;
  /** GBC: BGR555 palette words, `size` per sub-palette. Empty on DMG. */
  palWords: number[];
  /** GBC: colors per sub-palette. */
  palSize: number;
  /** DMG: the BGP register value. */
  bgp: number;
}

/** BGR555 packing: 5 bits each, blue high — the CGB's BCPD byte order. */
function bgr555(r: number, g: number, b: number): number {
  return (r & 31) | ((g & 31) << 5) | ((b & 31) << 10);
}

function buildGbData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GbData {
  const layout = spec.layout as TileLayout;
  const color = spec.color.model === "rgb";
  const tiled = extractTiles(img, layout);

  const tileBytes = new Uint8Array(tiled.tiles.length * tiled.tileH * tiled.bpp);
  tiled.tiles.forEach((grid, i) => {
    tileBytes.set(
      packPlanar(grid, tiled.tileW, tiled.tileH, tiled.bpp),
      i * tiled.tileH * tiled.bpp,
    );
  });

  const mapBytes = new Uint8Array(tiled.map.length);
  const attrBytes = color ? new Uint8Array(tiled.map.length) : new Uint8Array(0);
  for (let i = 0; i < tiled.map.length; i += 1) {
    const ref = tiled.map[i]!;
    const globalTile = opts.tileBase + ref.tile;
    mapBytes[i] = globalTile & 0xff;
    if (color) {
      const bank = globalTile > 0xff ? 1 : 0;
      attrBytes[i] =
        (tiled.cellPalette[i]! & 0x07) |
        (bank << 3) |
        ((ref.xflip ? 1 : 0) << 5) |
        ((ref.yflip ? 1 : 0) << 6);
    }
  }

  const palSize = layout.subPalettes.size;
  const palWords: number[] = [];
  let bgp = 0;
  if (color) {
    for (const pal of img.palettes) {
      for (let c = 0; c < palSize; c += 1) {
        const codes = pal.colors[c]?.codes ?? pal.colors[pal.colors.length - 1]?.codes ?? [0, 0, 0];
        palWords.push(bgr555(codes[0] ?? 0, codes[1] ?? 0, codes[2] ?? 0));
      }
    }
  } else {
    // BGP maps 2bpp index → shade: index i takes bits 2i..2i+1.
    const colors = img.palettes[0]?.colors ?? [];
    let lastShade = 0;
    for (let i = 0; i < 4; i += 1) {
      const shade = colors[i]?.codes[0] ?? lastShade;
      lastShade = shade;
      bgp |= (shade & 0x03) << (2 * i);
    }
  }

  return { color, tiled, tileBytes, mapBytes, attrBytes, palWords, palSize, bgp };
}

/** Split a word list into two little-endian bytes each. */
function wordsToBytes(words: readonly number[]): Uint8Array {
  const out = new Uint8Array(words.length * 2);
  for (let i = 0; i < words.length; i += 1) {
    out[i * 2] = words[i]! & 0xff;
    out[i * 2 + 1] = (words[i]! >> 8) & 0xff;
  }
  return out;
}

function emitBin(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildGbData(img, spec, opts);
  const artifacts: GenArtifact[] = [
    { suffix: ".tiles.bin", kind: "bin", bytes: d.tileBytes },
    { suffix: ".map.bin", kind: "bin", bytes: d.mapBytes },
  ];
  if (d.color) {
    artifacts.push({ suffix: ".attr.bin", kind: "bin", bytes: d.attrBytes });
    artifacts.push({ suffix: ".pal.bin", kind: "bin", bytes: wordsToBytes(d.palWords) });
  } else {
    artifacts.push({ suffix: ".bgp.bin", kind: "bin", bytes: new Uint8Array([d.bgp]) });
  }
  return artifacts;
}

/** Wrap provenance lines as RGBDS `;` comments. */
function asmHeader(header: readonly string[]): string {
  return header.map((l) => `; ${l}`).join("\n") + "\n\n";
}

/** RGBDS backtick 2bpp row for a tile's row of index values. */
function asmTileRow(grid: Uint8Array, tileW: number, y: number): string {
  let s = "";
  for (let x = 0; x < tileW; x += 1) s += String(grid[y * tileW + x]!);
  return "`" + s;
}

function dbList(bytes: Uint8Array | number[], perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    const slice = Array.from(bytes.slice(i, i + perLine), (b) => `$${hex2(b)}`);
    lines.push("    db " + slice.join(", "));
  }
  return lines.length ? lines.join("\n") : "    ; (none)";
}

function dwList(words: readonly number[], perLine = 8): string {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += perLine) {
    const slice = words.slice(i, i + perLine).map((w) => `$${w.toString(16).padStart(4, "0")}`);
    lines.push("    dw " + slice.join(", "));
  }
  return lines.length ? lines.join("\n") : "    ; (none)";
}

function emitAsm(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildGbData(img, spec, opts);
  const sym = opts.symbol;
  const out: string[] = [asmHeader(opts.header).trimEnd(), ""];

  out.push(`SECTION "${sym}_gfx", ROMX`, "");
  out.push(`${sym}_tiles::`);
  d.tiled.tiles.forEach((grid) => {
    for (let y = 0; y < d.tiled.tileH; y += 1)
      out.push("    dw " + asmTileRow(grid, d.tiled.tileW, y));
  });
  out.push(`${sym}_tiles_end::`);
  out.push(`DEF ${sym}_TILE_COUNT EQU ${d.tiled.tiles.length}`, "");

  out.push(`${sym}_map::`, dbList(d.mapBytes));
  out.push(`DEF ${sym}_MAP_W EQU ${d.tiled.tilesX}`, `DEF ${sym}_MAP_H EQU ${d.tiled.tilesY}`, "");

  if (d.color) {
    out.push(`${sym}_attr::`, dbList(d.attrBytes), "");
    out.push(`${sym}_pal::`, dwList(d.palWords));
    out.push(`DEF ${sym}_PAL_COUNT EQU ${img.palettes.length}`, "");
  } else {
    out.push(`DEF ${sym}_BGP EQU $${hex2(d.bgp)}`, "");
  }

  return [{ suffix: ".asm", kind: "asm", bytes: asciiBytes(out.join("\n") + "\n") }];
}

function cHeaderComment(header: readonly string[]): string {
  return "/*\n" + header.map((l) => ` * ${l}`).join("\n") + "\n */\n\n";
}

function cByteArray(name: string, bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = Array.from(bytes.slice(i, i + 16), (b) => `0x${hex2(b)}`);
    lines.push("    " + slice.join(", ") + ",");
  }
  return `const unsigned char ${name}[${bytes.length}] = {\n${lines.join("\n")}\n};\n`;
}

function cWordArray(name: string, words: readonly number[]): string {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 8) {
    const slice = words.slice(i, i + 8).map((w) => `0x${w.toString(16).padStart(4, "0")}`);
    lines.push("    " + slice.join(", ") + ",");
  }
  return `const unsigned short ${name}[${words.length}] = {\n${lines.join("\n")}\n};\n`;
}

function emitC(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildGbData(img, spec, opts);
  const sym = opts.symbol;
  const guard = sym.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_H";

  const c: string[] = [cHeaderComment(opts.header).trimEnd(), "", `#include "${sym}.h"`, ""];
  c.push(cByteArray(`${sym}_tiles`, d.tileBytes));
  c.push(cByteArray(`${sym}_map`, d.mapBytes));
  if (d.color) {
    c.push(cByteArray(`${sym}_attr`, d.attrBytes));
    c.push(cWordArray(`${sym}_pal`, d.palWords));
  }

  const h: string[] = [
    cHeaderComment(opts.header).trimEnd(),
    "",
    `#ifndef ${guard}`,
    `#define ${guard}`,
    "",
  ];
  h.push(`#define ${sym}_TILE_COUNT ${d.tiled.tiles.length}`);
  h.push(`#define ${sym}_MAP_W ${d.tiled.tilesX}`);
  h.push(`#define ${sym}_MAP_H ${d.tiled.tilesY}`);
  h.push(`extern const unsigned char ${sym}_tiles[${d.tileBytes.length}];`);
  h.push(`extern const unsigned char ${sym}_map[${d.mapBytes.length}];`);
  if (d.color) {
    h.push(`#define ${sym}_PAL_COUNT ${img.palettes.length}`);
    h.push(`extern const unsigned char ${sym}_attr[${d.attrBytes.length}];`);
    h.push(`extern const unsigned short ${sym}_pal[${d.palWords.length}];`);
  } else {
    h.push(`#define ${sym}_BGP 0x${hex2(d.bgp)}`);
  }
  h.push("", `#endif /* ${guard} */`, "");

  return [
    { suffix: ".c", kind: "c", bytes: asciiBytes(c.join("\n") + "\n") },
    { suffix: ".h", kind: "header", bytes: asciiBytes(h.join("\n")) },
  ];
}

/** The `gb` family backend (DMG + GBC). */
export const gbBackend: CodegenBackend = {
  family: "gb",
  emitBin,
  emitAsm,
  emitC,
};
