/**
 * The `vb` codegen family — Nintendo Virtual Boy (doc 06).
 *
 * Four structures, and three of them are shapes no other family in this project
 * emits:
 *
 *   - **A character is 2bpp packed pixel-pairs, leftmost pixel in the *lowest*
 *     bits** — {@link packPacked2Le}, which is the Neo Geo Pocket's halfword the
 *     other way round. Sixteen bytes a character, 2048 of them.
 *   - **A BGMap entry carries its own palette**, so there is no attribute table:
 *     eleven bits of character, a flip bit each way and two bits of palette
 *     select. The PC Engine's arrangement at a quarter of the depth.
 *   - **A palette is one byte for three colours**, because pixel value 0 is
 *     transparent on this hardware and shows `BKCOL` rather than a palette
 *     entry. So `.pal.bin` is four bytes for `GPLT0`–`GPLT3` and the backdrop is
 *     emitted beside them rather than inside them — the NES's shared index 0
 *     reached by different hardware.
 *   - **A world is the display list**, and it is the *only* structure here that
 *     is about depth. `.world.bin` is one 32-byte entry that puts the picture on
 *     the screen with a parallax the caller chose, plus a second entry that ends
 *     the list — because a display program that omitted the end marker would
 *     have the drawing processor walk thirty more worlds of whatever was in
 *     memory.
 *
 * That last one is why this family emits four files where `ws` emits four and
 * `gb` emits two: on every other console in the matrix, "where the picture goes"
 * is a scroll register, and here it is a structure with a depth field in it.
 *
 * `asm` targets this project's own V810 assembler rather than a distribution's,
 * because no distribution ships one — so the listing is `.hword`/`.byte`
 * directives in the GNU syntax the one published V810 port uses, which is what a
 * reader can paste into it.
 *
 * Sources: the Virtual Boy *Sacred Tech Scroll* (`vbtech`) — character, BGMap,
 * world and palette formats; Planet Virtual Boy — *VIP* wiki page.
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";
import {
  VB_WORLD_BGM_NORMAL,
  VB_WORLD_END,
  VB_WORLD_LON,
  VB_WORLD_RON,
  VB_WORLD_BYTES,
} from "../asm/vb.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, packPacked2Le, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

/** Bytes one character is: eight rows of one halfword. */
export const VB_CHAR_BYTES = 16;

/** BGMap palettes the display has. */
const PALETTES = 4;

/**
 * How far apart the two eyes' copies of a `gen`-emitted picture are placed.
 *
 * Zero — a backdrop sits *at* the screen, which is where a still picture
 * belongs: parallax is what puts something in front of or behind the display
 * plane, and a picture with nothing in front of it has nothing to be in front
 * of. A display program that wants depth writes its own value into
 * {@link VB_WORLD_GP}; this is the neutral one, and it is named rather than
 * left as a bare zero so that the choice is visible.
 */
export const VB_GEN_PARALLAX = 0;

interface VbData {
  tiled: TiledData;
  /** Sixteen bytes a character. */
  chrBytes: Uint8Array;
  /** Two bytes an entry, little-endian BGMap words. */
  mapBytes: Uint8Array;
  /** Four bytes: `GPLT0`–`GPLT3`, three colours each. */
  palBytes: Uint8Array;
  /** One byte: what every transparent pixel shows. */
  backdrop: number;
  /** Two 32-byte world entries: the picture, and the end of the list. */
  worldBytes: Uint8Array;
}

/**
 * One `GPLT` byte: three two-bit shades in bits 7–2.
 *
 * Bits 1–0 are unused because pixel value 0 never reads the palette — it is
 * transparent, and what shows through it is `BKCOL`. Writing a shade there is
 * harmless and misleading, so this leaves it zero.
 */
function paletteByte(shades: readonly number[]): number {
  return (
    (((shades[1] ?? 0) & 3) << 2) | (((shades[2] ?? 0) & 3) << 4) | (((shades[3] ?? 0) & 3) << 6)
  );
}

/** A world attribute entry as its sixteen halfwords. */
function worldEntry(head: number, fields: Partial<Record<number, number>>): Uint8Array {
  const out = new Uint8Array(VB_WORLD_BYTES);
  const put = (offset: number, value: number): void => {
    out[offset] = value & 0xff;
    out[offset + 1] = (value >> 8) & 0xff;
  };
  put(0, head);
  for (const [offset, value] of Object.entries(fields)) put(Number(offset), value ?? 0);
  return out;
}

function buildVbData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): VbData {
  const layout = spec.layout as TileLayout;
  const tiled = extractTiles(img, layout);

  const chrBytes = new Uint8Array(tiled.tiles.length * VB_CHAR_BYTES);
  tiled.tiles.forEach((grid, i) => {
    chrBytes.set(packPacked2Le(grid, tiled.tileW, tiled.tileH), i * VB_CHAR_BYTES);
  });

  const mapBytes = new Uint8Array(tiled.map.length * 2);
  tiled.map.forEach((ref, i) => {
    const character = opts.tileBase + ref.tile + opts.mapBase;
    const word =
      (character & 0x07ff) |
      ((ref.xflip ? 1 : 0) << 12) |
      ((ref.yflip ? 1 : 0) << 13) |
      ((tiled.cellPalette[i]! & (PALETTES - 1)) << 14);
    mapBytes[i * 2] = word & 0xff;
    mapBytes[i * 2 + 1] = (word >> 8) & 0xff;
  });

  const palBytes = new Uint8Array(PALETTES);
  for (let p = 0; p < PALETTES; p += 1) {
    const colors = img.palettes[p]?.colors ?? img.palettes[0]?.colors ?? [];
    palBytes[p] = paletteByte(colors.map((color) => color.codes[0] ?? 0));
  }
  const backdrop = (img.palettes[0]?.colors[0]?.codes[0] ?? 0) & 3;

  // Two entries: the picture, and the terminator. The picture is drawn into both
  // eyes at the same place, which is the display plane — see VB_GEN_PARALLAX.
  const world = worldEntry(VB_WORLD_LON | VB_WORLD_RON | VB_WORLD_BGM_NORMAL, {
    2: 0, // GX
    4: VB_GEN_PARALLAX, // GP — the depth
    6: 0, // GY
    8: 0, // MX
    10: 0, // MP
    12: 0, // MY
    14: tiled.tilesX * tiled.tileW - 1, // W
    16: tiled.tilesY * tiled.tileH - 1, // H
  });
  const end = worldEntry(VB_WORLD_END, {});
  const worldBytes = new Uint8Array(VB_WORLD_BYTES * 2);
  worldBytes.set(world, 0);
  worldBytes.set(end, VB_WORLD_BYTES);

  return { tiled, chrBytes, mapBytes, palBytes, backdrop, worldBytes };
}

function emitBin(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildVbData(img, spec, opts);
  return [
    { suffix: ".chr.bin", kind: "bin", bytes: d.chrBytes },
    { suffix: ".map.bin", kind: "bin", bytes: d.mapBytes },
    { suffix: ".pal.bin", kind: "bin", bytes: d.palBytes },
    { suffix: ".world.bin", kind: "bin", bytes: d.worldBytes },
  ];
}

/** GNU-syntax `.byte` list, which is what the published V810 port assembles. */
function byteList(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    lines.push(
      "    .byte " + Array.from(bytes.slice(i, i + perLine), (b) => `0x${hex2(b)}`).join(", "),
    );
  }
  return lines.length ? lines.join("\n") : "    /* (none) */";
}

function emitAsm(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildVbData(img, spec, opts);
  const sym = opts.symbol;
  const out = [opts.header.map((l) => `/* ${l} */`).join("\n"), ""];
  out.push(`    .equ ${sym}_CHAR_COUNT, ${d.tiled.tiles.length}`);
  out.push(`    .equ ${sym}_MAP_W, ${d.tiled.tilesX}`, `    .equ ${sym}_MAP_H, ${d.tiled.tilesY}`);
  out.push(`    .equ ${sym}_BKCOL, ${d.backdrop}`, "");
  out.push("    .section .rodata", "    .align 2", "");
  out.push(`${sym}_chars:`, byteList(d.chrBytes), "");
  out.push(`${sym}_map:`, byteList(d.mapBytes), "");
  out.push(`${sym}_palette:`, byteList(d.palBytes), "");
  out.push(
    "/* One world that draws the picture into both eyes at the display plane,",
    "   and one that ends the list. */",
    `${sym}_world:`,
    byteList(d.worldBytes),
    "",
  );
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
  const d = buildVbData(img, spec, opts);
  const sym = opts.symbol;
  const comment = "/*\n" + opts.header.map((l) => ` * ${l}`).join("\n") + "\n */\n";
  const c = [
    comment,
    cArray(`${sym}_chars`, d.chrBytes),
    cArray(`${sym}_map`, d.mapBytes),
    cArray(`${sym}_palette`, d.palBytes),
    cArray(`${sym}_world`, d.worldBytes),
  ].join("\n");
  const guard = sym.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_H";
  const h = [
    comment,
    `#ifndef ${guard}`,
    `#define ${guard}`,
    `#define ${sym}_CHAR_COUNT ${d.tiled.tiles.length}`,
    `#define ${sym}_MAP_W ${d.tiled.tilesX}`,
    `#define ${sym}_MAP_H ${d.tiled.tilesY}`,
    `#define ${sym}_BKCOL ${d.backdrop}`,
    `extern const unsigned char ${sym}_chars[${d.chrBytes.length}];`,
    `extern const unsigned char ${sym}_map[${d.mapBytes.length}];`,
    `extern const unsigned char ${sym}_palette[${d.palBytes.length}];`,
    `extern const unsigned char ${sym}_world[${d.worldBytes.length}];`,
    `#endif`,
    "",
  ].join("\n");
  return [
    { suffix: ".c", kind: "c", bytes: asciiBytes(c) },
    { suffix: ".h", kind: "header", bytes: asciiBytes(h) },
  ];
}

/** The `vb` family backend (Virtual Boy). */
export const vbBackend: CodegenBackend = {
  family: "vb",
  emitBin,
  emitAsm,
  emitC,
};
