/**
 * The exact-path detector (doc 06 §Input paths 1).
 *
 * Given raw pixels, try to *prove* they already satisfy a console's tiled
 * palette structure and, if so, reconstruct the {@link CompliantImage} losslessly
 * — no requantization. This is the constructive twin of the `inspect` oracle:
 * `inspect` reports whether a cover exists; this returns the cover (palettes,
 * per-cell assignment, per-pixel indices) so `gen` can emit it byte-for-byte.
 *
 * Returns `null` when compliance cannot be proven; `gen` then falls back to the
 * full `prep` pipeline (unless `--strict`).
 */

import { dacDecodeCodes } from "../image/dac.js";
import type { RgbaImage } from "../image/rgba.js";
import type { ConsoleSpec, RGB8, TileLayout } from "../consoles/types.js";
import type { CompliantImage, Palette, PaletteColor } from "../pipeline/types.js";

function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

/** Reverse lookup from a stored color to its hardware codes + both expansions. */
interface CodeEntry {
  codes: number[];
  raw: RGB8;
  display: RGB8;
}

/**
 * The color *encodings* a compliant PNG may be stored in: the raw lattice
 * expansion (author space — the `prep` default for panel-filter consoles like
 * the GBC, and what period tooling stores) or the DAC-decoded display color
 * (`--dac-colors`). An image must be provable under a single encoding; the
 * detector tries each in turn.
 */
type ColorEncoding = "raw" | "display";

/** Build stored-color → codes for every color the console can show, per encoding. */
function reverseColorMap(spec: ConsoleSpec, encoding: ColorEncoding): Map<number, CodeEntry> {
  const map = new Map<number, CodeEntry>();
  const { color } = spec;
  if (color.model === "rgb" && color.bitsPerChannel) {
    const bits = color.bitsPerChannel;
    for (let r = 0; r < 1 << bits[0]; r += 1) {
      for (let g = 0; g < 1 << bits[1]; g += 1) {
        for (let b = 0; b < 1 << bits[2]; b += 1) {
          const display = dacDecodeCodes(color.dac, [r, g, b], bits);
          const raw = { r: expand(r, bits[0]), g: expand(g, bits[1]), b: expand(b, bits[2]) };
          const stored = encoding === "raw" ? raw : display;
          const key = packRgb(stored.r, stored.g, stored.b);
          if (!map.has(key)) {
            map.set(key, { codes: [r, g, b], raw, display });
          }
        }
      }
    }
  } else if (color.model === "mono" && color.dac.kind === "mono-ramp") {
    const shades = color.dac.shades;
    shades.forEach((shade, i) => {
      // Raw = the `--raw-colors` neutral grayscale ramp (see `monoPalette`).
      const level = shades.length === 1 ? 255 : Math.round(255 * (1 - i / (shades.length - 1)));
      const raw = { r: level, g: level, b: level };
      const stored = encoding === "raw" ? raw : shade;
      map.set(packRgb(stored.r, stored.g, stored.b), { codes: [i], raw, display: { ...shade } });
    });
  }
  return map;
}

function expand(code: number, bits: number): number {
  if (bits >= 8) return code & 0xff;
  const shifted = code << (8 - bits);
  return (shifted | (shifted >> bits)) & 0xff;
}

/** Compare two code tuples lexicographically for a deterministic palette order. */
function compareCodes(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Try to reconstruct a compliant image, or return `null` if none is provable. */
export function detectCompliant(image: RgbaImage, spec: ConsoleSpec): CompliantImage | null {
  if (spec.layout.kind !== "tiles") return null;
  const layout = spec.layout as TileLayout;
  if (image.width > spec.display.width || image.height > spec.display.height) return null;
  if (image.width % layout.tileW !== 0 || image.height % layout.tileH !== 0) return null;

  const cellW = layout.attribute.w;
  const cellH = layout.attribute.h;
  if (image.width % cellW !== 0 || image.height % cellH !== 0) return null;

  // Try each stored-color encoding; a proof under either is a valid witness.
  // Raw first: it is the author-space default. When the DAC is the identity
  // (raw === display) the two maps coincide, so the second attempt is skipped.
  const rawMap = reverseColorMap(spec, "raw");
  const detected = detectWithMap(image, spec, rawMap);
  if (detected) return detected;
  const displayMap = reverseColorMap(spec, "display");
  if (mapsEqual(rawMap, displayMap)) return null;
  return detectWithMap(image, spec, displayMap);
}

function mapsEqual(a: Map<number, CodeEntry>, b: Map<number, CodeEntry>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}

/** Attempt the reconstruction under one stored-color encoding. */
function detectWithMap(
  image: RgbaImage,
  spec: ConsoleSpec,
  rev: Map<number, CodeEntry>,
): CompliantImage | null {
  const layout = spec.layout as TileLayout;
  const cellW = layout.attribute.w;
  const cellH = layout.attribute.h;
  const cellsX = image.width / cellW;
  const cellsY = image.height / cellH;
  const { count: P, size: K } = layout.subPalettes;
  const pixelKey = new Uint32Array(image.width * image.height);
  for (let i = 0; i < pixelKey.length; i += 1) {
    const o = i * 4;
    const key = packRgb(image.data[o]!, image.data[o + 1]!, image.data[o + 2]!);
    if (!rev.has(key)) return null; // off-lattice pixel
    pixelKey[i] = key;
  }

  // Per-cell distinct-color sets (≤ K each).
  const cellSets: Set<number>[] = [];
  for (let cy = 0; cy < cellsY; cy += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      const set = new Set<number>();
      for (let y = 0; y < cellH; y += 1) {
        for (let x = 0; x < cellW; x += 1) {
          set.add(pixelKey[(cy * cellH + y) * image.width + (cx * cellW + x)]!);
        }
      }
      if (set.size > K) return null;
      cellSets.push(set);
    }
  }

  // ≤ P palette cover by best-fit over unique cell-sets, largest-first — the same
  // strategy the oracle uses, but here we keep the assignment.
  const setKey = (s: Set<number>): string => [...s].sort((a, b) => a - b).join(",");
  const unique = new Map<string, Set<number>>();
  for (const s of cellSets) if (!unique.has(setKey(s))) unique.set(setKey(s), s);
  const ordered = [...unique.entries()].sort(
    (a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );

  const palSets: Set<number>[] = [];
  const setToPal = new Map<string, number>();
  for (const [key, set] of ordered) {
    let best = -1;
    let bestScore = -Infinity;
    for (let p = 0; p < palSets.length; p += 1) {
      const pal = palSets[p]!;
      let overlap = 0;
      for (const c of set) if (pal.has(c)) overlap += 1;
      const union = pal.size + set.size - overlap;
      if (union <= K) {
        const score = overlap * 100 - union;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
    }
    if (best >= 0) {
      for (const c of set) palSets[best]!.add(c);
      setToPal.set(key, best);
    } else if (palSets.length < P) {
      palSets.push(new Set(set));
      setToPal.set(key, palSets.length - 1);
    } else {
      return null; // no ≤P cover
    }
  }

  // Finalize palettes: order colors by hardware codes, index them.
  const palettes: Palette[] = [];
  const palIndexOf: Map<number, number>[] = [];
  for (const set of palSets) {
    const keys = [...set].sort((a, b) => compareCodes(rev.get(a)!.codes, rev.get(b)!.codes));
    const colors: PaletteColor[] = keys.map((key): PaletteColor => {
      const entry = rev.get(key)!;
      return { codes: entry.codes, display: entry.display, raw: entry.raw };
    });
    const index = new Map<number, number>();
    keys.forEach((key, i) => index.set(key, i));
    palettes.push({ colors });
    palIndexOf.push(index);
  }

  // Per-cell palette assignment + per-pixel color index.
  const cellPalette = new Uint16Array(cellsX * cellsY);
  for (let c = 0; c < cellSets.length; c += 1) cellPalette[c] = setToPal.get(setKey(cellSets[c]!))!;

  const pixelIndex = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const cell = Math.floor(y / cellH) * cellsX + Math.floor(x / cellW);
      pixelIndex[y * image.width + x] = palIndexOf[cellPalette[cell]!]!.get(
        pixelKey[y * image.width + x]!,
      )!;
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
