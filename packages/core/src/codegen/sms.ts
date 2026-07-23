/**
 * The `sms` codegen family — Master System + Game Gear (doc 06).
 *
 * Emits 4bpp **row-interleaved planar** tiles (four bitplane bytes per row, 32
 * bytes per tile), a 2-byte-per-entry name table (9-bit tile index + H/V flip +
 * palette-select + priority bits), and a background palette: 1 byte of RGB222 on
 * the SMS, or a 2-byte RGB444 word on the Game Gear — chosen from the spec's
 * `bitsPerChannel`. `asm` targets WLA-DX. The BG uses palette bank 0.
 */

import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

import { asciiBytes, hex2 } from "./text.js";
import { extractTiles, packPlanar, type TiledData } from "./tiles.js";
import type { CodegenBackend, EmitOptions, GenArtifact } from "./types.js";

interface SmsData {
  tiled: TiledData;
  tileBytes: Uint8Array;
  mapBytes: Uint8Array; // 2 bytes per entry
  palBytes: Uint8Array;
  gameGear: boolean;
}

/** Encode one palette color to CRAM bytes (SMS RGB222 = 1 byte, GG RGB444 = 2). */
function colorBytes(codes: readonly number[], gameGear: boolean): number[] {
  const r = codes[0] ?? 0;
  const g = codes[1] ?? 0;
  const b = codes[2] ?? 0;
  if (gameGear) {
    const word = (b << 8) | (g << 4) | r; // ----BBBBGGGGRRRR
    return [word & 0xff, (word >> 8) & 0xff];
  }
  return [((b & 3) << 4) | ((g & 3) << 2) | (r & 3)]; // --BBGGRR
}

function buildSmsData(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): SmsData {
  const layout = spec.layout as TileLayout;
  const gameGear = spec.color.bitsPerChannel?.[0] === 4;
  const tiled = extractTiles(img, layout);

  const tileBytes = new Uint8Array(tiled.tiles.length * 32);
  tiled.tiles.forEach((grid, i) => {
    tileBytes.set(packPlanar(grid, tiled.tileW, tiled.tileH, 4), i * 32);
  });

  const mapBytes = new Uint8Array(tiled.map.length * 2);
  tiled.map.forEach((ref, i) => {
    const tile = (opts.tileBase + ref.tile) & 0x1ff;
    const word = tile | ((ref.xflip ? 1 : 0) << 9) | ((ref.yflip ? 1 : 0) << 10);
    mapBytes[i * 2] = word & 0xff;
    mapBytes[i * 2 + 1] = (word >> 8) & 0xff;
  });

  const pal: number[] = [];
  for (const color of img.palettes[0]?.colors ?? []) pal.push(...colorBytes(color.codes, gameGear));
  return { tiled, tileBytes, mapBytes, palBytes: Uint8Array.from(pal), gameGear };
}

function emitBin(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildSmsData(img, spec, opts);
  return [
    { suffix: ".tiles.bin", kind: "bin", bytes: d.tileBytes },
    { suffix: ".map.bin", kind: "bin", bytes: d.mapBytes },
    { suffix: ".pal.bin", kind: "bin", bytes: d.palBytes },
  ];
}

function dbList(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    lines.push(".db " + Array.from(bytes.slice(i, i + perLine), (b) => `$${hex2(b)}`).join(", "));
  }
  return lines.length ? lines.join("\n") : "; (none)";
}

function emitAsm(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[] {
  const d = buildSmsData(img, spec, opts);
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
  const d = buildSmsData(img, spec, opts);
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

/** The `sms` family backend (Master System + Game Gear). */
export const smsBackend: CodegenBackend = {
  family: "sms",
  emitBin,
  emitAsm,
  emitC,
};
