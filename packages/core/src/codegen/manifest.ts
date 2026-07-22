/**
 * Manifest sidecar consumption (doc 06 §Input paths 1).
 *
 * A manifest — as written by `prep --emit-manifest` — records the fitted palettes
 * and their order. When one is supplied to `gen` and matches the image, it
 * *short-circuits detection and pins palette order*, so regenerating never
 * reshuffles palette indices (which would perturb `asm`/`c` symbol layouts).
 *
 * Matching is strict: the console and dimensions must agree, the embedded image
 * hash (when present) must match the input bytes, and every attribute cell's
 * colors must be covered by one manifest palette. Any failure is a hard
 * `E_MANIFEST_MISMATCH` rather than a silent fall-through — the caller asked to
 * pin this manifest.
 */

import { DemakeError } from "../errors.js";
import { expandChannel } from "../color/lattice.js";
import type { RgbaImage } from "../image/rgba.js";
import type { ConsoleSpec, RGB8, TileLayout } from "../consoles/types.js";
import type { CompliantImage, Palette, PaletteColor } from "../pipeline/types.js";

import { sourceHash } from "./provenance.js";

/** A manifest palette color (a subset of {@link PaletteColor}). */
interface ManifestColor {
  codes: number[];
  display: RGB8;
}

/** The sidecar shape `prep --emit-manifest` writes (plus optional imageHash). */
export interface CodegenManifest {
  schemaVersion: number;
  console: string;
  width: number;
  height: number;
  palettes: ManifestColor[][];
  imageHash?: string;
}

function packRgb(c: RGB8): number {
  return (c.r << 16) | (c.g << 8) | c.b;
}

function fail(message: string): never {
  throw new DemakeError("E_MANIFEST_MISMATCH", message, {
    hint: "regenerate the manifest for this exact image, or drop --manifest to auto-detect.",
  });
}

/** Parse manifest bytes into a validated {@link CodegenManifest}. */
export function parseManifest(bytes: Uint8Array): CodegenManifest {
  let text = "";
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]!);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DemakeError("E_MANIFEST_MISMATCH", "manifest is not valid JSON");
  }
  const m = raw as Partial<CodegenManifest>;
  if (!m || typeof m.console !== "string" || !Array.isArray(m.palettes)) {
    throw new DemakeError("E_MANIFEST_MISMATCH", "manifest is missing required fields");
  }
  return m as CodegenManifest;
}

/** Build a compliant image from an image + a pinned manifest, or throw. */
export function applyManifest(
  image: RgbaImage,
  spec: ConsoleSpec,
  manifest: CodegenManifest,
  sourceBytes: Uint8Array,
): CompliantImage {
  if (spec.layout.kind !== "tiles") fail(`manifest path supports tiled consoles only`);
  const layout = spec.layout as TileLayout;

  if (manifest.console !== spec.id && !spec.aliases.includes(manifest.console)) {
    fail(`manifest console '${manifest.console}' does not match '${spec.id}'`);
  }
  if (manifest.width !== image.width || manifest.height !== image.height) {
    fail(
      `manifest is ${manifest.width}×${manifest.height}, image is ${image.width}×${image.height}`,
    );
  }
  if (manifest.imageHash !== undefined && manifest.imageHash !== sourceHash(sourceBytes)) {
    fail("manifest image hash does not match the input image");
  }

  const rgb =
    spec.color.model === "rgb" && spec.color.bitsPerChannel ? spec.color.bitsPerChannel : null;
  const palettes: Palette[] = manifest.palettes.map((pal) => ({
    colors: pal.map((c): PaletteColor => ({
      codes: c.codes,
      display: c.display,
      raw: rgb
        ? {
            r: expandChannel(c.codes[0] ?? 0, rgb[0]),
            g: expandChannel(c.codes[1] ?? 0, rgb[1]),
            b: expandChannel(c.codes[2] ?? 0, rgb[2]),
          }
        : c.display,
    })),
  }));
  if (palettes.length > layout.subPalettes.count) {
    fail(`manifest has ${palettes.length} palettes (> ${layout.subPalettes.count})`);
  }

  // Display-color → index maps, per manifest palette (order pinned).
  const palMaps = palettes.map((p) => {
    const idx = new Map<number, number>();
    p.colors.forEach((c, i) => idx.set(packRgb(c.display), i));
    return idx;
  });

  const cellW = layout.attribute.w;
  const cellH = layout.attribute.h;
  const cellsX = image.width / cellW;
  const cellsY = image.height / cellH;

  const cellPalette = new Uint16Array(cellsX * cellsY);
  const pixelIndex = new Uint8Array(image.width * image.height);

  for (let cy = 0; cy < cellsY; cy += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      const keys: number[] = [];
      for (let y = 0; y < cellH; y += 1) {
        for (let x = 0; x < cellW; x += 1) {
          const o = ((cy * cellH + y) * image.width + (cx * cellW + x)) * 4;
          keys.push(packRgb({ r: image.data[o]!, g: image.data[o + 1]!, b: image.data[o + 2]! }));
        }
      }
      // First palette (pinned order) that covers this cell's colors.
      let chosen = -1;
      for (let p = 0; p < palMaps.length; p += 1) {
        if (keys.every((k) => palMaps[p]!.has(k))) {
          chosen = p;
          break;
        }
      }
      if (chosen < 0) fail(`a cell's colors are not covered by any manifest palette`);
      cellPalette[cy * cellsX + cx] = chosen;
      const pmap = palMaps[chosen]!;
      for (let y = 0; y < cellH; y += 1) {
        for (let x = 0; x < cellW; x += 1) {
          const px = cx * cellW + x;
          const py = cy * cellH + y;
          const o = (py * image.width + px) * 4;
          pixelIndex[py * image.width + px] = pmap.get(
            packRgb({ r: image.data[o]!, g: image.data[o + 1]!, b: image.data[o + 2]! }),
          )!;
        }
      }
    }
  }

  return {
    consoleId: spec.id,
    width: image.width,
    height: image.height,
    grid: { cellsX, cellsY, attributeW: cellW, attributeH: cellH },
    palettes,
    cellPalette,
    pixelIndex,
  };
}
