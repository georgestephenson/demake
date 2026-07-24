/**
 * The compliance oracle (doc 04 §The judge → validity gates, doc 05 `inspect`).
 *
 * Two entry points, deliberately separate:
 *
 * - {@link checkCompliantImage} validates the engine's own {@link CompliantImage}
 *   structure — trivially sound (each cell already carries its palette). The
 *   tournament's validity gate uses this, so a valid candidate is never wrongly
 *   disqualified.
 * - {@link inspect} is the public, best-effort check on arbitrary PNG bytes:
 *   decode, then try to *prove* the pixels fit the console's palette structure
 *   (dimensions, colors on the hardware lattice, ≤K colors per cell, a ≤P
 *   palette cover, tile budget). Proving compliance is a witness; failing to
 *   prove it is reported as a violation rather than a false "compliant".
 */

import { expandChannel } from "../color/lattice.js";
import { dacDecodeCodes } from "../image/dac.js";
import { decodeImage } from "../image/decode.js";
import type { RgbaImage } from "../image/rgba.js";
import { consoles as allConsoles, getConsole } from "../consoles/registry.js";
import type { ConsoleSpec, TileLayout } from "../consoles/types.js";

import type { CompliantImage } from "../pipeline/types.js";

/** A single compliance failure. */
export interface Violation {
  code: string;
  message: string;
}

/** Per-console compliance verdict. */
export interface ConsoleCompliance {
  console: string;
  compliant: boolean;
  violations: Violation[];
}

/** Result of {@link inspect}. */
export interface InspectResult {
  width: number;
  height: number;
  colors: number;
  consoles: ConsoleCompliance[];
}

const VALID_COLOR_CACHE = new Map<string, Set<number>>();

function colorKeyRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

/**
 * The set of valid stored colors (as packed RGB) for a console: the union of
 * every color either **encoding** of a hardware code can produce — the raw
 * lattice expansion (the author-space PNG, and what tools like the predecessor
 * scripts store) and the DAC-decoded display color (`--dac-colors`). Every
 * member maps back to real hardware codes, so membership stays a sound witness.
 */
function validColorSet(spec: ConsoleSpec): Set<number> {
  const cached = VALID_COLOR_CACHE.get(spec.id);
  if (cached) return cached;
  const set = new Set<number>();
  if (spec.color.model === "rgb" && spec.color.bitsPerChannel) {
    const [rb, gb, bb] = spec.color.bitsPerChannel;
    for (let r = 0; r < 1 << rb; r += 1) {
      for (let g = 0; g < 1 << gb; g += 1) {
        for (let b = 0; b < 1 << bb; b += 1) {
          const c = dacDecodeCodes(spec.color.dac, [r, g, b], spec.color.bitsPerChannel);
          set.add(colorKeyRgb(c.r, c.g, c.b));
          set.add(colorKeyRgb(expandChannel(r, rb), expandChannel(g, gb), expandChannel(b, bb)));
        }
      }
    }
  } else if (spec.color.model === "mono" && spec.color.dac.kind === "mono-ramp") {
    const shades = spec.color.dac.shades;
    shades.forEach((c, s) => {
      set.add(colorKeyRgb(c.r, c.g, c.b));
      // The `--raw-colors` neutral grayscale ramp (see `monoPalette`).
      const level = shades.length === 1 ? 255 : Math.round(255 * (1 - s / (shades.length - 1)));
      set.add(colorKeyRgb(level, level, level));
    });
  } else if (spec.color.model === "fixed-master" && spec.color.masterPalette) {
    for (const c of spec.color.masterPalette) {
      set.add(colorKeyRgb(c.r, c.g, c.b));
    }
  }
  VALID_COLOR_CACHE.set(spec.id, set);
  return set;
}

/** Validate an engine {@link CompliantImage} against its console (sound). */
export function checkCompliantImage(image: CompliantImage, spec: ConsoleSpec): Violation[] {
  const violations: Violation[] = [];
  if (spec.layout.kind === "scanline" && spec.layout.strategy === "tms-rowpair") {
    return checkTmsImage(image, spec);
  }
  if (spec.layout.kind !== "tiles") {
    return [{ code: "E_UNSUPPORTED_LAYOUT", message: `no oracle for ${spec.layout.kind} layouts` }];
  }
  const layout = spec.layout as TileLayout;
  const { count: P, size: K } = layout.subPalettes;

  if (image.width > spec.display.width || image.height > spec.display.height) {
    violations.push({
      code: "E_SIZE",
      message: `${image.width}×${image.height} exceeds ${spec.id} ${spec.display.width}×${spec.display.height}`,
    });
  }
  if (image.width % layout.tileW !== 0 || image.height % layout.tileH !== 0) {
    violations.push({
      code: "E_GRANULARITY",
      message: `dimensions must be multiples of ${layout.tileW}`,
    });
  }
  if (image.palettes.length > P) {
    violations.push({
      code: "E_PALETTE_COUNT",
      message: `${image.palettes.length} palettes exceed ${P}`,
    });
  }
  const valid = validColorSet(spec);
  for (let p = 0; p < image.palettes.length; p += 1) {
    const pal = image.palettes[p]!;
    if (pal.colors.length > K) {
      violations.push({
        code: "E_PALETTE_SIZE",
        message: `palette ${p} has ${pal.colors.length} colors (> ${K})`,
      });
    }
    for (const color of pal.colors) {
      if (!valid.has(colorKeyRgb(color.display.r, color.display.g, color.display.b))) {
        violations.push({
          code: "E_OFF_LATTICE",
          message: `palette ${p} has a color not on the ${spec.id} lattice`,
        });
        break;
      }
    }
  }

  // Shared index-0 backdrop (NES): color 0 of every non-empty sub-palette must be
  // the same universal backdrop, or a pixel of value 0 could not render uniformly.
  if (layout.subPalettes.sharedIndex0) {
    let backdrop: string | undefined;
    for (let p = 0; p < image.palettes.length; p += 1) {
      const first = image.palettes[p]!.colors[0];
      if (!first) continue;
      const key = first.codes.join(",");
      if (backdrop === undefined) backdrop = key;
      else if (key !== backdrop) {
        violations.push({
          code: "E_SHARED_BACKDROP",
          message: `sub-palettes must share color 0 (the ${spec.id} backdrop)`,
        });
        break;
      }
    }
  }
  return violations;
}

/**
 * TMS9918 Graphics II oracle: 256×192 max, tile-aligned, and — the defining rule
 * — every 8×1 cell shows at most two colors, drawn from the fixed master. There
 * is no global palette-count cap (the color table stores two colors per tile
 * row), so palettes are validated per-cell, not against a `subPalettes.count`.
 */
function checkTmsImage(image: CompliantImage, spec: ConsoleSpec): Violation[] {
  const violations: Violation[] = [];
  if (image.width > spec.display.width || image.height > spec.display.height) {
    violations.push({
      code: "E_SIZE",
      message: `${image.width}×${image.height} exceeds ${spec.id} ${spec.display.width}×${spec.display.height}`,
    });
  }
  if (image.width % 8 !== 0 || image.height % 8 !== 0) {
    violations.push({ code: "E_GRANULARITY", message: "dimensions must be multiples of 8" });
  }
  const valid = validColorSet(spec);
  for (let p = 0; p < image.palettes.length; p += 1) {
    const pal = image.palettes[p]!;
    if (pal.colors.length > 2) {
      violations.push({
        code: "E_PALETTE_SIZE",
        message: `cell palette ${p} has ${pal.colors.length} colors (> 2 per row)`,
      });
    }
    for (const color of pal.colors) {
      if (!valid.has(colorKeyRgb(color.display.r, color.display.g, color.display.b))) {
        violations.push({
          code: "E_OFF_LATTICE",
          message: `cell palette ${p} has a color not in the ${spec.id} master`,
        });
        break;
      }
    }
  }
  return violations;
}

/** Public best-effort compliance check on arbitrary image bytes. */
export function inspect(bytes: Uint8Array, options: { console?: string } = {}): InspectResult {
  const image = decodeImage(bytes);
  const distinct = new Set<number>();
  for (let i = 0; i < image.data.length; i += 4) {
    distinct.add(colorKeyRgb(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!));
  }

  const specs = options.console ? [getConsole(options.console)] : allConsoles();
  const results: ConsoleCompliance[] = specs.map((spec) => {
    const violations = checkImageBytes(image, spec);
    return { console: spec.id, compliant: violations.length === 0, violations };
  });

  return { width: image.width, height: image.height, colors: distinct.size, consoles: results };
}

/** Try to prove a raw raster fits a console's tiled palette structure. */
function checkImageBytes(image: RgbaImage, spec: ConsoleSpec): Violation[] {
  const violations: Violation[] = [];
  if (spec.layout.kind !== "tiles") {
    return [{ code: "E_UNSUPPORTED_LAYOUT", message: `no oracle for ${spec.layout.kind} layouts` }];
  }
  const layout = spec.layout as TileLayout;
  if (image.width > spec.display.width || image.height > spec.display.height) {
    violations.push({ code: "E_SIZE", message: `too large for ${spec.id}` });
  }
  if (image.width % layout.tileW !== 0 || image.height % layout.tileH !== 0) {
    violations.push({ code: "E_GRANULARITY", message: `not a multiple of ${layout.tileW}px` });
  }

  const valid = validColorSet(spec);
  const cellW = layout.attribute.w;
  const cellH = layout.attribute.h;
  const cellsX = Math.floor(image.width / cellW);
  const cellsY = Math.floor(image.height / cellH);
  const { count: P, size: K } = layout.subPalettes;

  // Gather each cell's distinct colors; check on-lattice + ≤K per cell.
  const cellSets: Set<number>[] = [];
  let offLattice = false;
  for (let cy = 0; cy < cellsY; cy += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      const set = new Set<number>();
      for (let y = 0; y < cellH; y += 1) {
        for (let x = 0; x < cellW; x += 1) {
          const px = cx * cellW + x;
          const py = cy * cellH + y;
          const i = (py * image.width + px) * 4;
          const key = colorKeyRgb(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!);
          if (!valid.has(key)) offLattice = true;
          set.add(key);
        }
      }
      if (set.size > K) {
        violations.push({
          code: "E_CELL_COLORS",
          message: `a cell has ${set.size} colors (> ${K})`,
        });
        return violations;
      }
      cellSets.push(set);
    }
  }
  if (offLattice) {
    violations.push({
      code: "E_OFF_LATTICE",
      message: `colors are not all on the ${spec.id} lattice`,
    });
  }

  // Shared index-0 (NES backdrop / MD·SNES transparent): one color is shared by
  // every sub-palette, so subtract a backdrop candidate and cover the remainder
  // into P palettes of K−1. The backdrop is whichever color the producer chose —
  // not necessarily the most common in the *output* — so try a small deterministic
  // candidate list; finding a cover under any candidate is a sound witness.
  if (layout.subPalettes.sharedIndex0 !== undefined) {
    for (const backdrop of backdropCandidates(image, cellSets)) {
      const reduced = cellSets.map((s) => {
        const t = new Set(s);
        t.delete(backdrop);
        return t;
      });
      if (coverFits(reduced, P, Math.max(1, K - 1))) return violations;
    }
    violations.push({
      code: "E_PALETTE_COVER",
      message: `could not fit cells into ${P} sub-palettes of ${K}`,
    });
    return violations;
  }

  if (!coverFits(cellSets, P, K)) {
    violations.push({
      code: "E_PALETTE_COVER",
      message: `could not fit cells into ${P} sub-palettes of ${K}`,
    });
  }
  return violations;
}

/**
 * ≤P palette cover: each cell-set must be a subset of some palette of ≤K
 * colors. First-fit fragments palettes, so use best-fit by *maximum overlap*
 * over deduplicated, largest-first cell-sets. Finding a cover is a sound
 * witness of compliance; failing to find one is reported, not assumed.
 */
function coverFits(sets: Set<number>[], P: number, K: number): boolean {
  const uniqueSets = dedupeSets(sets).sort((a, b) => b.size - a.size);
  const palettes: Set<number>[] = [];
  for (const set of uniqueSets) {
    let bestPal: Set<number> | null = null;
    let bestScore = -Infinity;
    for (const pal of palettes) {
      let overlap = 0;
      for (const c of set) if (pal.has(c)) overlap += 1;
      const unionSize = pal.size + set.size - overlap;
      if (unionSize <= K) {
        const score = overlap * 100 - unionSize;
        if (score > bestScore) {
          bestScore = score;
          bestPal = pal;
        }
      }
    }
    if (bestPal) {
      for (const c of set) bestPal.add(c);
    } else if (palettes.length < P) {
      palettes.push(new Set(set));
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Plausible shared-backdrop colors, most likely first: ordered by how many
 * distinct cell-sets contain the color (the backdrop is in *every* palette, so
 * it tends to appear across many cells), then by pixel count, then lowest key.
 */
function backdropCandidates(image: RgbaImage, cellSets: Set<number>[]): number[] {
  const pixelCounts = new Map<number, number>();
  for (let i = 0; i < image.data.length; i += 4) {
    const key = colorKeyRgb(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!);
    pixelCounts.set(key, (pixelCounts.get(key) ?? 0) + 1);
  }
  const setCounts = new Map<number, number>();
  for (const set of cellSets) {
    for (const c of set) setCounts.set(c, (setCounts.get(c) ?? 0) + 1);
  }
  return [...pixelCounts.keys()]
    .sort((a, b) => {
      const s = (setCounts.get(b) ?? 0) - (setCounts.get(a) ?? 0);
      if (s !== 0) return s;
      const p = pixelCounts.get(b)! - pixelCounts.get(a)!;
      return p !== 0 ? p : a - b;
    })
    .slice(0, 8);
}

/** Deduplicate color-sets by their canonical (sorted) key. */
function dedupeSets(sets: Set<number>[]): Set<number>[] {
  const seen = new Map<string, Set<number>>();
  for (const set of sets) {
    const key = [...set].sort((a, b) => a - b).join(",");
    if (!seen.has(key)) seen.set(key, set);
  }
  return [...seen.values()];
}
