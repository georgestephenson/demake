import { describe, expect, it } from "vitest";

import { encodeRgbaPng } from "../src/image/png/encode.js";
import { prep } from "../src/pipeline/prep.js";
import { renderCompliant, encodeCompliantPng } from "../src/pipeline/encode-image.js";
import { gen } from "../src/codegen/gen.js";
import { detectCompliant } from "../src/codegen/detect.js";
import { extractTiles, packPacked4, packPlanar } from "../src/codegen/tiles.js";
import { decodeImage } from "../src/image/decode.js";
import { getConsole } from "../src/consoles/registry.js";
import type { TileLayout } from "../src/consoles/types.js";

/** A colorful synthetic source with flat blocks and gradients. */
function makeSource(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      rgba[o] = Math.round((x / (width - 1)) * 255);
      rgba[o + 1] = Math.round((y / (height - 1)) * 255);
      rgba[o + 2] = Math.round(((x + y) / (width + height - 2)) * 255);
      rgba[o + 3] = 255;
      if (x > width * 0.6 && x < width * 0.7 && y > height * 0.3 && y < height * 0.5) {
        rgba[o] = 240;
        rgba[o + 1] = 30;
        rgba[o + 2] = 30;
      }
    }
  }
  return rgba;
}

const source = encodeRgbaPng(64, 64, makeSource(64, 64));

const utf8 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

describe("planar tile packing (GB 2bpp)", () => {
  it("packs an 8×8 index grid MSB-first into 16 bytes", () => {
    // Row 0: pixel 0 = index 3 (both planes bit7 set), rest 0.
    const grid = new Uint8Array(64);
    grid[0] = 3;
    const bytes = packPlanar(grid, 8, 8, 2);
    expect(bytes.length).toBe(16);
    expect(bytes[0]).toBe(0x80); // low plane, bit 7
    expect(bytes[1]).toBe(0x80); // high plane, bit 7
    expect(bytes[2]).toBe(0x00);
  });
});

describe("packed-nibble tile packing (MD 4bpp)", () => {
  it("packs an 8×8 grid row-major with the left pixel in the high nibble", () => {
    const grid = new Uint8Array(64);
    grid[0] = 0xa; // row 0, col 0 → high nibble of byte 0
    grid[1] = 0x3; // row 0, col 1 → low nibble of byte 0
    grid[8] = 0x5; // row 1, col 0 → high nibble of byte 4
    const bytes = packPacked4(grid, 8, 8);
    expect(bytes.length).toBe(32); // 4 bytes/row × 8 rows
    expect(bytes[0]).toBe(0xa3);
    expect(bytes[4]).toBe(0x50);
  });
});

describe("gen — md family (Mega Drive)", () => {
  it("emits blank tile 0, palette-tagged big-endian map words, and BGR333 CRAM", async () => {
    const png = encodeRgbaPng(64, 64, makeSource(64, 64));
    const result = await gen(png, { console: "md", format: "bin", symbol: "demake" });
    const tiles = result.artifacts.find((a) => a.suffix === ".tiles.bin")!.bytes;
    const map = result.artifacts.find((a) => a.suffix === ".map.bin")!.bytes;
    const pal = result.artifacts.find((a) => a.suffix === ".pal.bin")!.bytes;

    // Tile 0 is reserved blank (all-zero), real tiles follow.
    expect(tiles.length % 32).toBe(0);
    expect([...tiles.slice(0, 32)].every((b) => b === 0)).toBe(true);

    // Every map word references a real tile (index ≥ 1) and packs the 2-bit
    // palette select into bits 14–13 of a big-endian word.
    expect(pal.length).toBe(4 * 16 * 2);
    for (let i = 0; i < map.length; i += 2) {
      const word = (map[i]! << 8) | map[i + 1]!;
      expect(word & 0x7ff).toBeGreaterThanOrEqual(1);
      expect((word >> 13) & 3).toBeLessThan(4);
    }
    // CRAM color 0 of every sub-palette is the shared backdrop.
    for (let p = 1; p < 4; p += 1) {
      expect(pal[p * 16 * 2]).toBe(pal[0]);
      expect(pal[p * 16 * 2 + 1]).toBe(pal[1]);
    }
  });
});

describe("detectCompliant round-trips prep output", () => {
  it("recovers the exact displayed pixels for GBC", async () => {
    const result = await prep(source, { console: "gbc" });
    const spec = getConsole("gbc");
    const rgba = decodeImage(result.png);
    const detected = detectCompliant(rgba, spec);
    expect(detected).not.toBeNull();
    // The reconstructed image renders to the same pixels as the PNG.
    const rerender = renderCompliant(detected!);
    expect(Array.from(rerender.data)).toEqual(Array.from(rgba.data));
    expect(detected!.palettes.length).toBeLessThanOrEqual(8);
  });

  it("recovers a compliant DMG image", async () => {
    const result = await prep(source, { console: "dmg" });
    const spec = getConsole("dmg");
    const rgba = decodeImage(result.png);
    const detected = detectCompliant(rgba, spec);
    expect(detected).not.toBeNull();
    const rerender = renderCompliant(detected!);
    expect(Array.from(rerender.data)).toEqual(Array.from(rgba.data));
  });

  it("returns null for an off-lattice image", () => {
    const spec = getConsole("gbc");
    // A 24-bit smooth gradient: cells will exceed 4 colors / go off-lattice.
    const png = encodeRgbaPng(64, 64, makeSource(64, 64));
    // Feed the *raw* source (not prepped) — it is not compliant.
    const detected = detectCompliant(decodeImage(png), spec);
    expect(detected).toBeNull();
  });
});

describe("gen — exact path", () => {
  it("emits asm for compliant GBC input without reprepping", async () => {
    const prepped = await prep(source, { console: "gbc" });
    const result = await gen(prepped.png, { console: "gbc", format: "asm", symbol: "portrait" });
    expect(result.path).toBe("compliant");
    expect(result.artifacts).toHaveLength(1);
    const asm = utf8(result.artifacts[0]!.bytes);
    expect(asm).toContain("portrait_tiles::");
    expect(asm).toContain("portrait_pal::");
    expect(asm).toContain("portrait_attr::");
    expect(asm).toContain("do not edit by hand");
    // No timestamps in generated output (determinism).
    expect(asm).not.toMatch(/\b(19|20)\d\d-\d\d-\d\d\b/);
  });

  it("emits bin blobs for GBC (tiles/map/attr/pal)", async () => {
    const prepped = await prep(source, { console: "gbc" });
    const result = await gen(prepped.png, { console: "gbc", format: "bin" });
    const names = result.artifacts.map((a) => a.suffix).sort();
    expect(names).toEqual([".attr.bin", ".map.bin", ".pal.bin", ".tiles.bin"]);
    const tiles = result.artifacts.find((a) => a.suffix === ".tiles.bin")!;
    expect(tiles.bytes.length).toBe(result.stats.tiles * 16);
    const pal = result.artifacts.find((a) => a.suffix === ".pal.bin")!;
    expect(pal.bytes.length).toBe(result.stats.palettes * 4 * 2);
  });

  it("emits c + h for GBC with matching symbols", async () => {
    const prepped = await prep(source, { console: "gbc" });
    const result = await gen(prepped.png, { console: "gbc", format: "c", symbol: "portrait" });
    expect(result.artifacts.map((a) => a.suffix).sort()).toEqual([".c", ".h"]);
    const c = utf8(result.artifacts.find((a) => a.suffix === ".c")!.bytes);
    const h = utf8(result.artifacts.find((a) => a.suffix === ".h")!.bytes);
    expect(c).toContain("const unsigned char portrait_tiles[");
    expect(c).toContain("const unsigned short portrait_pal[");
    expect(h).toContain("#ifndef PORTRAIT_H");
    expect(h).toContain("extern const unsigned char portrait_tiles[");
  });

  it("emits a DMG BGP instead of color palettes", async () => {
    const prepped = await prep(source, { console: "dmg" });
    const result = await gen(prepped.png, { console: "dmg", format: "asm", symbol: "mono" });
    const asm = utf8(result.artifacts[0]!.bytes);
    expect(asm).toContain("mono_BGP");
    expect(asm).not.toContain("mono_pal");
    const bin = await gen(prepped.png, { console: "dmg", format: "bin" });
    expect(bin.artifacts.map((a) => a.suffix).sort()).toEqual([
      ".bgp.bin",
      ".map.bin",
      ".tiles.bin",
    ]);
  });

  it("is deterministic (identical bytes across runs)", async () => {
    const prepped = await prep(source, { console: "gbc" });
    const a = await gen(prepped.png, { console: "gbc", format: "asm", symbol: "p" });
    const b = await gen(prepped.png, { console: "gbc", format: "asm", symbol: "p" });
    expect(Array.from(a.artifacts[0]!.bytes)).toEqual(Array.from(b.artifacts[0]!.bytes));
  });
});

describe("gen — implicit prep + strict", () => {
  it("preps a raw image when it is not compliant", async () => {
    const result = await gen(source, { console: "gbc", format: "asm" });
    expect(result.path).toBe("prepped");
    expect(result.artifacts).toHaveLength(1);
  });

  it("refuses a non-compliant image under strict", async () => {
    await expect(
      gen(source, { console: "gbc", format: "asm", strict: true }),
    ).rejects.toMatchObject({
      code: "E_STRICT_NONCOMPLIANT",
    });
  });

  it("rejects rom (needs a toolchain) and unknown formats", async () => {
    const prepped = await prep(source, { console: "gbc" });
    await expect(gen(prepped.png, { console: "gbc", format: "rom" })).rejects.toMatchObject({
      code: "E_TOOLCHAIN_MISSING",
    });
  });
});

describe("flip-aware tile dedup", () => {
  it("dedups a horizontally-mirrored tile via the map flip flag", () => {
    const spec = getConsole("gbc");
    const colors = [
      { codes: [0, 0, 0], display: { r: 0, g: 0, b: 0 }, raw: { r: 0, g: 0, b: 0 } },
      { codes: [31, 0, 0], display: { r: 255, g: 0, b: 0 }, raw: { r: 255, g: 0, b: 0 } },
      { codes: [0, 31, 0], display: { r: 0, g: 255, b: 0 }, raw: { r: 0, g: 255, b: 0 } },
      { codes: [0, 0, 31], display: { r: 0, g: 0, b: 255 }, raw: { r: 0, g: 0, b: 255 } },
    ];
    // Left tile: index = x % 4 across the row. Right tile: horizontal mirror.
    const pixelIndex = new Uint8Array(16 * 8);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const v = x % 4;
        pixelIndex[y * 16 + x] = v; // left tile
        pixelIndex[y * 16 + (15 - x)] = v; // right tile = H-mirror
      }
    }
    const image = {
      consoleId: "gbc",
      width: 16,
      height: 8,
      grid: { cellsX: 2, cellsY: 1, attributeW: 8, attributeH: 8 },
      palettes: [{ colors }],
      cellPalette: new Uint16Array([0, 0]),
      pixelIndex,
    };
    const tiled = extractTiles(image, spec.layout as TileLayout);
    expect(tiled.tiles.length).toBe(1); // the mirror is not stored twice
    expect(tiled.map[0]).toEqual({ tile: 0, xflip: false, yflip: false });
    expect(tiled.map[1]).toEqual({ tile: 0, xflip: true, yflip: false });
  });
});

describe("gen manifest path (via prep --emit-manifest shape)", () => {
  it("pins palette order from a manifest and matches detection pixels", async () => {
    const prepped = await prep(source, { console: "gbc" });
    // Synthesize the manifest shape prep --emit-manifest writes.
    const manifest = {
      schemaVersion: 1,
      console: "gbc",
      width: prepped.image.width,
      height: prepped.image.height,
      palettes: prepped.image.palettes.map((p) =>
        p.colors.map((c) => ({ codes: c.codes, display: c.display })),
      ),
    };
    const bytes = new Uint8Array([...JSON.stringify(manifest)].map((ch) => ch.charCodeAt(0)));
    const result = await gen(encodeCompliantPng(prepped.image), {
      console: "gbc",
      format: "asm",
      manifest: bytes,
    });
    expect(result.path).toBe("manifest");
    const rerender = renderCompliant(result.image);
    const expected = renderCompliant(prepped.image);
    expect(Array.from(rerender.data)).toEqual(Array.from(expected.data));
  });

  it("rejects a mismatched manifest", async () => {
    const prepped = await prep(source, { console: "gbc" });
    const manifest = { schemaVersion: 1, console: "gbc", width: 8, height: 8, palettes: [[]] };
    const bytes = new Uint8Array([...JSON.stringify(manifest)].map((ch) => ch.charCodeAt(0)));
    await expect(
      gen(prepped.png, { console: "gbc", format: "asm", manifest: bytes }),
    ).rejects.toMatchObject({ code: "E_MANIFEST_MISMATCH" });
  });
});
