/**
 * Pipeline data types (doc 02 §The core engine, doc 09 §Public API surface).
 *
 * `LinImage` is the working buffer — linear-light RGB in `Float32Array`, no
 * per-pixel objects (doc 04 §Performance). `CompliantImage` is the central
 * output type: indexed pixels + fitted sub-palettes + per-cell palette
 * assignment + the console it satisfies. Everything is plain JSON-able data
 * (plus typed arrays) so it crosses workers/processes untouched (doc 09).
 */

import type { RGB8 } from "../consoles/types.js";

/** A linear-light RGB working image (`data.length === width * height * 3`). */
export interface LinImage {
  width: number;
  height: number;
  /** Linear-light RGB, row-major, 3 channels per pixel. */
  data: Float32Array;
}

/** One entry of a fitted sub-palette. */
export interface PaletteColor {
  /** Raw hardware codes: `[r,g,b]` lattice codes, or `[shade]` / `[masterIndex]`. */
  codes: readonly number[];
  /** DAC-decoded sRGB — what the hardware screen shows (`--dac-colors`). */
  display: RGB8;
  /** Raw lattice-expansion sRGB — the author-space color (default PNG color for panel-filter consoles). */
  raw: RGB8;
}

/** A fitted sub-palette. */
export interface Palette {
  colors: PaletteColor[];
}

/** Attribute-cell grid geometry. */
export interface CellGrid {
  cellsX: number;
  cellsY: number;
  attributeW: number;
  attributeH: number;
}

/**
 * The central internal type (doc 02): a hardware-compliant indexed image.
 *
 * A pixel's displayed color is
 * `palettes[cellPalette[cell]].colors[pixelIndex[px]].display`.
 */
export interface CompliantImage {
  consoleId: string;
  width: number;
  height: number;
  grid: CellGrid;
  palettes: Palette[];
  /** Sub-palette index per attribute cell, row-major over the cell grid. */
  cellPalette: Uint16Array;
  /** Color index (within its cell's palette) per pixel, row-major. */
  pixelIndex: Uint8Array;
}

/** Downscale kernel choices (doc 04 §Stage 2). */
export type ScaleKernel = "majority" | "lanczos3" | "box" | "nearest" | "auto";

/** Dither algorithms (doc 04 §Stage 5). */
export type DitherAlg =
  "none" | "bayer2" | "bayer4" | "bayer8" | "floyd-steinberg" | "atkinson" | "riemersma" | "ramp";

/** Source-analysis profile (doc 04 §Stage 1). */
export type Profile = "art" | "photo" | "auto";

/** Optimizer budget (doc 04 §The tournament). */
export type Effort = "fast" | "default" | "max";

/** Perceptual metric selection (doc 04 §Color distance). */
export type Metric = "oklab" | "wrgb";

/**
 * Minimal `AbortSignal` shape. Core deliberately does not pull in the DOM/Node
 * lib types (that would resolve `window`/`fetch` and defeat the platform-purity
 * lint), so long-running runs accept this structural subset — a real
 * `AbortSignal` satisfies it.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

/** Options for {@link prep} (doc 09). */
export interface PrepOptions {
  console: string;
  strategy?: string;
  size?: { w: number; h: number };
  fit?: "contain" | "cover" | "stretch" | "pad";
  mode?: string;
  profile?: Profile;
  scale?: ScaleKernel;
  dither?: { alg: DitherAlg; strength?: number };
  protect?: string[] | false;
  palette?: string[];
  focus?: { x: number; y: number } | "auto";
  effort?: Effort;
  metric?: Metric;
  seed?: number;
  background?: string;
  keepTransparency?: boolean;
  strict?: boolean;
  /** Force raw lattice-expansion colors in the output (the default for panel-filter consoles). */
  rawColors?: boolean;
  /** Force DAC-simulated display colors in the output (`--dac-colors`). */
  dacColors?: boolean;
  onProgress?: (stage: string, fraction: number) => void;
  signal?: AbortSignalLike;
}

/** Auto-decisions the pipeline made, surfaced so callers can pin them. */
export interface AutoDecisions {
  profile: "art" | "photo";
  size: { w: number; h: number };
  scale: ScaleKernel;
  dither: { alg: DitherAlg; strength: number };
  strategy: string;
}

/** Quality statistics from the fit. */
export interface FitStats {
  meanDeltaE: number;
  p95DeltaE: number;
  /** Palette pressure the judge weights were slid by (doc 04 §The objective). */
  palettePressure: number;
  uniqueTiles: number;
  tileBudget: number | null;
  tileMerges: number;
  restarts: number;
}

/** A non-fatal quality/compat warning. */
export interface Warning {
  code: string;
  message: string;
}

/** Per-candidate judge scores (doc 04 §The judge, doc 09). */
export interface CandidateScore {
  strategy: string;
  aggregate: number;
  metrics: Record<string, number>;
  disqualified?: { reason: string };
}

/** Result of {@link prep} (doc 09). */
export interface PrepResult {
  png: Uint8Array;
  image: CompliantImage;
  decisions: AutoDecisions;
  stats: FitStats;
  warnings: Warning[];
  tournament: { winner: string; candidates: CandidateScore[] };
}
