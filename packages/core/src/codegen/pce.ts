/**
 * The `pce` codegen family — PC Engine / TurboGrafx-16 (doc 06).
 *
 * Emits HuC6270 VDC background structures: 4bpp **word-planar** characters (32
 * bytes each — words 0–7 hold bitplanes 0/1 of rows 0–7, words 8–15 bitplanes
 * 2/3, low byte the lower plane), a 2-byte-per-entry BAT word (12-bit character
 * number + 4-bit palette select, little-endian for the 6280), and 16 sixteen-
 * color VCE sub-palettes as 9-bit `GGGRRRBBB` words. Color 0 of every background
 * palette displays VCE entry 0 — the shared backdrop — which is the same
 * shared-index-0 machinery the Mega Drive and SNES backends use. The BAT has no
 * per-tile flip, so the tileset is deduplicated by identity only. `asm` targets
 * WLA-DX (`wla-huc6280`).
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

/** Sub-palettes the VCE gives the background plane, and their size. */
const PALETTES = 16;
const PALETTE_SIZE = 16;

interface PceData {
  tiled: TiledData;
  tileBytes: Uint8Array;
  mapBytes: Uint8Array; // 2 bytes per entry, little-endian BAT words
  palBytes: Uint8Array; // 16 × 16 × 2 bytes, little-endian VCE words
}

/**
 * Pack an 8×8 index grid into one HuC6270 character: 16 VRAM words, stored
 * little-endian. Word `y` (bytes `2y`, `2y+1`) carries bitplane 0 of row `y` in
 * its low byte and bitplane 1 in its high byte; word `8+y` does the same for
 * bitplanes 2 and 3. Bit 7 of each plane byte is the leftmost pixel.
 */
export function packPceChar(grid: Uint8Array, tileW: number, tileH: number): Uint8Array {
  const out = new Uint8Array(tileH * 4);
  for (let y = 0; y < tileH; y += 1) {
    for (let plane = 0; plane < 4; plane += 1) {
      let byte = 0;
      for (let x = 0; x < tileW; x += 1) {
        byte |= ((grid[y * tileW + x]! >> plane) & 1) << (tileW - 1 - x);
      }
      // Planes 0/1 share word y; planes 2/3 share word 8+y. Low byte first.
      out[(plane >> 1) * tileH * 2 + y * 2 + (plane & 1)] = byte;
    }
  }
  return out;
}

/** One VCE palette word: `0000000G GGRRRBBB`, little-endian byte pair. */
function colorBytes(codes: readonly number[]): [number, number] {
  const r = (codes[0] ?? 0) & 7;
  const g = (codes[1] ?? 0) & 7;
  const b = (codes[2] ?? 0) & 7;
  const word = (g << 6) | (r << 3) | b;
  return [word & 0xff, (word >> 8) & 0xff];
}

function buildPceData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): PceData {
  const layout = spec.layout as TileLayout;
  const tiled = extractTiles(img, layout);

  const tileBytes = new Uint8Array(tiled.tiles.length * 32);
  tiled.tiles.forEach((grid, i) => {
    tileBytes.set(packPceChar(grid, tiled.tileW, tiled.tileH), i * 32);
  });

  // BAT: 12-bit character number, 4-bit palette select, little-endian.
  const mapBytes = new Uint8Array(tiled.map.length * 2);
  tiled.map.forEach((ref, i) => {
    const tile = (opts.tileBase + ref.tile) & 0xfff;
    const word = tile | ((tiled.cellPalette[i]! & 0xf) << 12);
    mapBytes[i * 2] = word & 0xff;
    mapBytes[i * 2 + 1] = (word >> 8) & 0xff;
  });

  // 16 sub-palettes; color 0 of each one is the shared backdrop (VCE entry 0).
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
  const d = buildPceData(img, spec, opts);
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
  const d = buildPceData(img, spec, opts);
  const sym = opts.symbol;
  const out = [opts.header.map((l) => `; ${l}`).join("\n"), ""];
  out.push(`${sym}_chars:`, dbList(d.tileBytes));
  out.push(`.define ${sym}_CHAR_COUNT ${d.tiled.tiles.length}`, "");
  out.push(`${sym}_bat:`, dbList(d.mapBytes));
  out.push(`.define ${sym}_BAT_W ${d.tiled.tilesX}`, `.define ${sym}_BAT_H ${d.tiled.tilesY}`, "");
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
  const d = buildPceData(img, spec, opts);
  const sym = opts.symbol;
  const comment = "/*\n" + opts.header.map((l) => ` * ${l}`).join("\n") + "\n */\n";
  const c = [
    comment,
    cArray(`${sym}_chars`, d.tileBytes),
    cArray(`${sym}_bat`, d.mapBytes),
    cArray(`${sym}_palette`, d.palBytes),
  ].join("\n");
  const guard = sym.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_H";
  const h = [
    comment,
    `#ifndef ${guard}`,
    `#define ${guard}`,
    `#define ${sym}_CHAR_COUNT ${d.tiled.tiles.length}`,
    `#define ${sym}_BAT_W ${d.tiled.tilesX}`,
    `#define ${sym}_BAT_H ${d.tiled.tilesY}`,
    `extern const unsigned char ${sym}_chars[${d.tileBytes.length}];`,
    `extern const unsigned char ${sym}_bat[${d.mapBytes.length}];`,
    `extern const unsigned char ${sym}_palette[${d.palBytes.length}];`,
    `#endif`,
    "",
  ].join("\n");
  return [
    { suffix: ".c", kind: "c", bytes: asciiBytes(c) },
    { suffix: ".h", kind: "header", bytes: asciiBytes(h) },
  ];
}

/** The `pce` family backend (PC Engine / TurboGrafx-16). */
export const pceBackend: CodegenBackend = {
  family: "pce",
  emitBin,
  emitAsm,
  emitC,
};
