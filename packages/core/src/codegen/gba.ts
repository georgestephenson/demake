/**
 * The `gba` codegen family — Game Boy Advance, and (through
 * {@link makeAgbStyleBackend}) the Nintendo DS 2D engine, which inherited the
 * same background formats (doc 06).
 *
 * Emits text-BG structures: 4bpp tiles in packed nibbles with the **left pixel in
 * the low nibble** (the ARM engines' little-endian VRAM order), a
 * 2-byte-per-entry screen entry (10-bit tile index, H/V flip, 4-bit palette
 * bank, little-endian), and 16 sub-palettes of 16 BGR555 colors. Color 0 of every
 * palette is the shared transparent backdrop; palette entry 0 of bank 0 is the
 * hardware backdrop a transparent pixel shows, so it carries the same color.
 * `asm` targets GNU as (`arm-none-eabi-as`).
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, packPacked4Le, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

interface AgbData {
  tiled: TiledData;
  tileBytes: Uint8Array;
  mapBytes: Uint8Array; // 2 bytes/entry, little-endian screen entries
  palBytes: Uint8Array; // count × size × 2 bytes, little-endian BGR555
}

/** One palette word: 0BBBBBGG GGGRRRRR, little-endian (low byte first). */
function colorBytes(codes: readonly number[]): [number, number] {
  const r = (codes[0] ?? 0) & 31;
  const g = (codes[1] ?? 0) & 31;
  const b = (codes[2] ?? 0) & 31;
  const word = (b << 10) | (g << 5) | r;
  return [word & 0xff, (word >> 8) & 0xff];
}

function buildAgbData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): AgbData {
  const layout = spec.layout as TileLayout;
  const tiled = extractTiles(img, layout);

  const tileBytes = new Uint8Array(tiled.tiles.length * 32);
  tiled.tiles.forEach((grid, i) => {
    tileBytes.set(packPacked4Le(grid, tiled.tileW, tiled.tileH), i * 32);
  });

  // Screen entry: PPPP V H TTTTTTTTTT.
  const mapBytes = new Uint8Array(tiled.map.length * 2);
  tiled.map.forEach((ref, i) => {
    const tile = (opts.tileBase + ref.tile) & 0x3ff;
    const word =
      tile |
      ((ref.xflip ? 1 : 0) << 10) |
      ((ref.yflip ? 1 : 0) << 11) |
      ((tiled.cellPalette[i]! & 0xf) << 12);
    mapBytes[i * 2] = word & 0xff;
    mapBytes[i * 2 + 1] = (word >> 8) & 0xff;
  });

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

/** GNU as `.byte` list. */
function byteList(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    lines.push(
      "    .byte " + Array.from(bytes.slice(i, i + perLine), (b) => `0x${hex2(b)}`).join(", "),
    );
  }
  return lines.length ? lines.join("\n") : "    @ (none)";
}

function cArray(name: string, bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push("    " + Array.from(bytes.slice(i, i + 16), (b) => `0x${hex2(b)}`).join(", ") + ",");
  }
  return `const unsigned char ${name}[${bytes.length}] = {\n${lines.join("\n")}\n};\n`;
}

/**
 * Build a backend for an ARM 2D-engine family. The GBA and the DS main/sub
 * engines share every data format here — only the ROM harness that uploads them
 * differs — so one implementation serves both families (doc 02 §Extensibility).
 */
export function makeAgbStyleBackend(family: string): CodegenBackend {
  return {
    family,
    emitBin(img, spec, opts) {
      const d = buildAgbData(img, spec, opts);
      return [
        { suffix: ".tiles.bin", kind: "bin", bytes: d.tileBytes },
        { suffix: ".map.bin", kind: "bin", bytes: d.mapBytes },
        { suffix: ".pal.bin", kind: "bin", bytes: d.palBytes },
      ];
    },
    emitAsm(img, spec, opts): GenArtifact[] {
      const d = buildAgbData(img, spec, opts);
      const sym = opts.symbol;
      const out = [opts.header.map((l) => `@ ${l}`).join("\n"), ""];
      out.push(`    .equ ${sym}_TILE_COUNT, ${d.tiled.tiles.length}`);
      out.push(
        `    .equ ${sym}_MAP_W, ${d.tiled.tilesX}`,
        `    .equ ${sym}_MAP_H, ${d.tiled.tilesY}`,
        "",
      );
      out.push("    .section .rodata", "    .align 2", `    .global ${sym}_tiles`);
      out.push(`${sym}_tiles:`, byteList(d.tileBytes), "");
      out.push("    .align 2", `    .global ${sym}_map`, `${sym}_map:`, byteList(d.mapBytes), "");
      out.push("    .align 2", `    .global ${sym}_pal`, `${sym}_pal:`, byteList(d.palBytes), "");
      return [{ suffix: ".asm", kind: "asm", bytes: asciiBytes(out.join("\n") + "\n") }];
    },
    emitC(img, spec, opts): GenArtifact[] {
      const d = buildAgbData(img, spec, opts);
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
    },
  };
}

/** The `gba` family backend (Game Boy Advance, Mode 0 text BG). */
export const gbaBackend: CodegenBackend = makeAgbStyleBackend("gba");
