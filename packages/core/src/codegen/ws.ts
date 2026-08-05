/**
 * The `ws` codegen family — Bandai WonderSwan, the mono machine (doc 06).
 *
 * The colour machine's structures at half the depth and with one more level of
 * indirection, which is what makes this a family of its own rather than a flag
 * on `wsc`:
 *
 *   - **Tiles are planar 2bpp**, sixteen bytes each, MSB-first per row — the
 *     layout every 8-bit console in this set uses and none of the colour
 *     machine's, so {@link packPlanar} is called rather than `packPacked4`.
 *   - **The map word is the same** — nine bits of tile, four of palette, two of
 *     flip, little-endian for the V30MZ — because the two machines' display
 *     controllers read the same screen map. The bank bit has nothing to select
 *     here, since 512 sixteen-byte tiles are the whole 8 KiB the bank is.
 *   - **A palette is four three-bit indices into a shared pool**, not four
 *     colour words. So this family emits *two* things where `wsc` emits one: the
 *     pool (`.pool.bin`, four bytes for ports `$1C`–`$1F`, two four-bit LCD
 *     levels a byte) and the palettes (`.pal.bin`, thirty-two bytes for ports
 *     `$20`–`$3F`, two entries a byte, low nibble first).
 *
 * The pool is **derived rather than given**, because a compliant image stores
 * the level a palette entry shows and not the slot it came from
 * (`pipeline/fit-mono-tiled.ts` §What a `codes` entry holds). That is the right
 * way round: "at most eight distinct levels" is then a property of the picture
 * that `inspect` can check, and this file is where it becomes eight registers.
 *
 * `asm` targets NASM (16-bit x86, the V30MZ's instruction set), exactly as the
 * colour family does.
 *
 * Sources: WSdev wiki — Display/Palette, Display/IO Ports, Display/Tiles.
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, packPlanar, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

/** Palettes the display controller has, and entries in one of them. */
const PALETTES = 16;
const PALETTE_SIZE = 4;

/** Entries the shade pool holds, and LCD levels it is chosen from. */
export const WS_POOL_SIZE = 8;
const WS_LEVELS = 16;

/** Bytes one tile is: eight rows of two planes. */
export const WS_TILE_BYTES = 16;

interface WsData {
  tiled: TiledData;
  tileBytes: Uint8Array;
  /** Two bytes per entry, little-endian screen words. */
  mapBytes: Uint8Array;
  /** Four bytes: eight four-bit LCD levels, two a byte, low nibble first. */
  poolBytes: Uint8Array;
  /** Thirty-two bytes: sixteen palettes of four three-bit pool indices. */
  palBytes: Uint8Array;
  /** The levels the pool holds, in slot order — what the registers mean. */
  pool: number[];
}

/**
 * The eight levels the pool holds, from what the picture actually shows.
 *
 * The used levels first, ascending, and then — if the picture spent fewer than
 * eight — whichever unused levels are furthest from the ones already in, so the
 * slots the hardware has are filled rather than left holding zero. A build's own
 * art draws through this pool too, and a slot holding a duplicate is a shade the
 * objects and the font cannot reach.
 */
export function poolFor(img: CompliantImage, size = WS_POOL_SIZE): number[] {
  const used = new Set<number>();
  for (const palette of img.palettes) {
    for (const color of palette.colors) used.add((color.codes[0] ?? 0) & (WS_LEVELS - 1));
  }
  const pool = [...used].sort((a, b) => a - b);
  while (pool.length < size) {
    let best = -1;
    let bestGap = -1;
    for (let level = 0; level < WS_LEVELS; level += 1) {
      if (pool.includes(level)) continue;
      let gap = WS_LEVELS;
      for (const held of pool) gap = Math.min(gap, Math.abs(held - level));
      if (gap > bestGap) {
        bestGap = gap;
        best = level;
      }
    }
    if (best < 0) break;
    pool.push(best);
    pool.sort((a, b) => a - b);
  }
  return pool.slice(0, size);
}

/** Pack a run of small fields two to a byte, low nibble first. */
function packNibbles(values: readonly number[], count: number, mask: number): Uint8Array {
  const out = new Uint8Array(count >> 1);
  for (let i = 0; i < count; i += 2) {
    out[i >> 1] = ((values[i] ?? 0) & mask) | (((values[i + 1] ?? 0) & mask) << 4);
  }
  return out;
}

function buildWsData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): WsData {
  const layout = spec.layout as TileLayout;
  const tiled = extractTiles(img, layout);

  const tileBytes = new Uint8Array(tiled.tiles.length * WS_TILE_BYTES);
  tiled.tiles.forEach((grid, i) => {
    tileBytes.set(packPlanar(grid, tiled.tileW, tiled.tileH, layout.bpp), i * WS_TILE_BYTES);
  });

  // The same screen word the colour machine reads: nine bits of tile, four of
  // palette, H flip at 14 and V flip at 15.
  const mapBytes = new Uint8Array(tiled.map.length * 2);
  tiled.map.forEach((ref, i) => {
    const tile = opts.tileBase + ref.tile;
    const word =
      (tile & 0x1ff) |
      ((tiled.cellPalette[i]! & 0xf) << 9) |
      ((ref.xflip ? 1 : 0) << 14) |
      ((ref.yflip ? 1 : 0) << 15);
    mapBytes[i * 2] = word & 0xff;
    mapBytes[i * 2 + 1] = (word >> 8) & 0xff;
  });

  const pool = poolFor(img);
  const slotOf = new Map(pool.map((level, slot) => [level, slot]));
  // Colour zero is transparent on both background layers, so an entry the fit
  // did not supply carries the shared backdrop rather than slot zero by default
  // — the same reasoning `wsc.ts` applies to its own index 0.
  const backdrop = slotOf.get(img.palettes[0]?.colors[0]?.codes[0] ?? pool[0]!) ?? 0;
  const entries: number[] = [];
  for (let p = 0; p < PALETTES; p += 1) {
    const colors = img.palettes[p]?.colors ?? [];
    for (let c = 0; c < PALETTE_SIZE; c += 1) {
      const level = colors[c]?.codes[0];
      entries.push(level === undefined ? backdrop : (slotOf.get(level) ?? backdrop));
    }
  }

  return {
    tiled,
    tileBytes,
    mapBytes,
    poolBytes: packNibbles(pool, WS_POOL_SIZE, 0x0f),
    palBytes: packNibbles(entries, PALETTES * PALETTE_SIZE, 0x07),
    pool,
  };
}

function emitBin(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildWsData(img, spec, opts);
  return [
    { suffix: ".tiles.bin", kind: "bin", bytes: d.tileBytes },
    { suffix: ".map.bin", kind: "bin", bytes: d.mapBytes },
    { suffix: ".pool.bin", kind: "bin", bytes: d.poolBytes },
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
  const d = buildWsData(img, spec, opts);
  const sym = opts.symbol;
  const out = [opts.header.map((l) => `; ${l}`).join("\n"), ""];
  out.push(`%define ${sym}_TILE_COUNT ${d.tiled.tiles.length}`);
  out.push(`%define ${sym}_MAP_W ${d.tiled.tilesX}`, `%define ${sym}_MAP_H ${d.tiled.tilesY}`);
  out.push(`; shade pool (ports $1C-$1F), as LCD levels: ${d.pool.join(", ")}`, "");
  out.push(`${sym}_tiles:`, dbList(d.tileBytes), "");
  out.push(`${sym}_map:`, dbList(d.mapBytes), "");
  out.push(`${sym}_pool:`, dbList(d.poolBytes), "");
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
  const d = buildWsData(img, spec, opts);
  const sym = opts.symbol;
  const comment = "/*\n" + opts.header.map((l) => ` * ${l}`).join("\n") + "\n */\n";
  const c = [
    comment,
    cArray(`${sym}_tiles`, d.tileBytes),
    cArray(`${sym}_map`, d.mapBytes),
    cArray(`${sym}_pool`, d.poolBytes),
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
    `extern const unsigned char ${sym}_pool[${d.poolBytes.length}];`,
    `extern const unsigned char ${sym}_palette[${d.palBytes.length}];`,
    `#endif`,
    "",
  ].join("\n");
  return [
    { suffix: ".c", kind: "c", bytes: asciiBytes(c) },
    { suffix: ".h", kind: "header", bytes: asciiBytes(h) },
  ];
}

/** The `ws` family backend (WonderSwan, mono). */
export const wsBackend: CodegenBackend = {
  family: "ws",
  emitBin,
  emitAsm,
  emitC,
};
