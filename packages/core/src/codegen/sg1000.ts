/**
 * The `sg1000` codegen family — Sega SG-1000, TMS9918A Graphics II (doc 06).
 *
 * Emits the two per-tile VDP tables the mode needs: an 8-byte **pattern** (one
 * bitmask row per line, MSB = leftmost pixel, 1 = foreground) and an 8-byte
 * **color** table (one byte per line = foreground<<4 | background, master indices
 * 0–15). Tiles are emitted in row-major order and never deduplicated — Graphics
 * II gives each of the 768 name-table cells its own pattern/color slot, so the
 * VRAM bank layout (three 256-tile thirds) and the name table are assembled at
 * the ROM edge. `asm` targets WLA-DX (Z80).
 */

import type { ConsoleSpec } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

interface Sg1000Data {
  pattern: Uint8Array; // tilesX*tileRows tiles × 8 bytes, row-major
  color: Uint8Array; // same shape
  tilesX: number;
  tileRows: number;
}

function buildSg1000Data(img: CompliantImage): Sg1000Data {
  const tilesX = Math.floor(img.width / 8);
  const tileRows = Math.floor(img.height / 8);
  const tiles = tilesX * tileRows;
  const pattern = new Uint8Array(tiles * 8);
  const color = new Uint8Array(tiles * 8);
  const cellsX = img.grid.cellsX;

  for (let tr = 0; tr < tileRows; tr += 1) {
    for (let tx = 0; tx < tilesX; tx += 1) {
      const tile = tr * tilesX + tx;
      for (let row = 0; row < 8; row += 1) {
        const cy = tr * 8 + row;
        const cell = cy * cellsX + tx;
        const pal = img.palettes[img.cellPalette[cell]!]!;
        const bg = pal.colors[0]?.codes[0] ?? 1;
        const fg = pal.colors[1]?.codes[0] ?? bg;

        let bits = 0;
        for (let px = 0; px < 8; px += 1) {
          if (img.pixelIndex[cy * img.width + tx * 8 + px]! === 1) bits |= 1 << (7 - px);
        }
        pattern[tile * 8 + row] = bits;
        color[tile * 8 + row] = ((fg & 0x0f) << 4) | (bg & 0x0f);
      }
    }
  }
  return { pattern, color, tilesX, tileRows };
}

function emitBin(img: CompliantImage): GenArtifact[] {
  const d = buildSg1000Data(img);
  return [
    { suffix: ".pattern.bin", kind: "bin", bytes: d.pattern },
    { suffix: ".color.bin", kind: "bin", bytes: d.color },
  ];
}

function dbList(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    lines.push(".db " + Array.from(bytes.slice(i, i + perLine), (b) => `$${hex2(b)}`).join(", "));
  }
  return lines.length ? lines.join("\n") : "; (none)";
}

function emitAsm(img: CompliantImage, _spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildSg1000Data(img);
  const sym = opts.symbol;
  const out = [opts.header.map((l) => `; ${l}`).join("\n"), ""];
  out.push(`.define ${sym}_MAP_W ${d.tilesX}`, `.define ${sym}_MAP_H ${d.tileRows}`, "");
  out.push(`${sym}_pattern:`, dbList(d.pattern), "");
  out.push(`${sym}_color:`, dbList(d.color), "");
  return [{ suffix: ".asm", kind: "asm", bytes: asciiBytes(out.join("\n") + "\n") }];
}

function cArray(name: string, bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push("    " + Array.from(bytes.slice(i, i + 16), (b) => `0x${hex2(b)}`).join(", ") + ",");
  }
  return `const unsigned char ${name}[${bytes.length}] = {\n${lines.join("\n")}\n};\n`;
}

function emitC(img: CompliantImage, _spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildSg1000Data(img);
  const sym = opts.symbol;
  const comment = "/*\n" + opts.header.map((l) => ` * ${l}`).join("\n") + "\n */\n";
  const c = [comment, cArray(`${sym}_pattern`, d.pattern), cArray(`${sym}_color`, d.color)].join(
    "\n",
  );
  const guard = sym.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_H";
  const h = [
    comment,
    `#ifndef ${guard}`,
    `#define ${guard}`,
    `#define ${sym}_MAP_W ${d.tilesX}`,
    `#define ${sym}_MAP_H ${d.tileRows}`,
    `extern const unsigned char ${sym}_pattern[${d.pattern.length}];`,
    `extern const unsigned char ${sym}_color[${d.color.length}];`,
    `#endif`,
    "",
  ].join("\n");
  return [
    { suffix: ".c", kind: "c", bytes: asciiBytes(c) },
    { suffix: ".h", kind: "header", bytes: asciiBytes(h) },
  ];
}

/** The `sg1000` family backend (Sega SG-1000, TMS9918A Graphics II). */
export const sg1000Backend: CodegenBackend = {
  family: "sg1000",
  emitBin: (img) => emitBin(img),
  emitAsm,
  emitC,
};
