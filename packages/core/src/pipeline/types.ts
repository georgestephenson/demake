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
import type { ImageFormat } from "../image/decode.js";
import type { Executor } from "../parallel/jobs.js";

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

/*
 * The closed option sets, as runtime lists with the types derived from them.
 *
 * Values rather than bare types because two callers have to *check* a string
 * against them: the CLI parsing a flag, and `@demake/demotic` reading an option
 * out of a Demakefile (doc 15 §Resolution). Both used to carry their own copy of
 * the spelling, which is a list that goes stale the first time one is added.
 */

/** Downscale kernel choices (doc 04 §Stage 2). */
export const SCALE_KERNELS = ["majority", "lanczos3", "box", "nearest", "auto"] as const;
export type ScaleKernel = (typeof SCALE_KERNELS)[number];

/** Dither algorithms (doc 04 §Stage 5). */
export const DITHER_ALGS = [
  "none",
  "bayer2",
  "bayer4",
  "bayer8",
  "floyd-steinberg",
  "atkinson",
  "riemersma",
  "ramp",
] as const;
export type DitherAlg = (typeof DITHER_ALGS)[number];

/** Source-analysis profile (doc 04 §Stage 1). */
export const PROFILES = ["art", "photo", "auto"] as const;
export type Profile = (typeof PROFILES)[number];

/** Optimizer budget (doc 04 §The tournament). */
export const EFFORTS = ["fast", "default", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Perceptual metric selection (doc 04 §Color distance). */
export const METRICS = ["oklab", "wrgb"] as const;
export type Metric = (typeof METRICS)[number];

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
  /**
   * Fit into at most this many of the console's sub-palettes.
   *
   * Defaults to all of them. A caller reserves the rest for something the
   * picture does not own: `demake build` keeps one Game Boy Color background
   * palette back for the font, so a score stays legible over a title screen
   * whose palettes were chosen for the title screen.
   */
  maxSubPalettes?: number;
  /**
   * Fit into at most this many tiles, rather than the console's whole budget.
   *
   * The same reservation `maxSubPalettes` makes, for the other scarce resource.
   * A caller that is putting the picture somewhere it does not own outright says
   * how much of the tile bank is actually free: `demake build` on the NES has 256
   * background patterns, of which the font, the level patterns and the placeholder
   * block have already taken sixty-one, and a full-screen picture is 960 cells.
   * Reserving here rather than merging afterwards is what keeps the fit honest —
   * the budget stage merges the *closest* tiles, where a caller trimming a finished
   * conversion could only drop the last ones it happened to see.
   */
  maxTiles?: number;
  /**
   * Fit into at most this many colours of each sub-palette.
   *
   * The third reservation, alongside {@link PrepOptions.maxSubPalettes} and
   * {@link PrepOptions.maxTiles}, and it exists for a console whose palette is
   * one flat block rather than a set of sub-palettes: on a Game Boy Advance a
   * cell may use any of 256 colours, so there is no sub-palette to hold back for
   * the font and the reservation has to be expressed in colours instead.
   * `demake build` keeps three of the 256 for the runtime's own ink.
   */
  maxColors?: number;
  /**
   * Which of the console's selectable layouts to fit into.
   *
   * Absent is the console's primary layout, which is what `prep` on the command
   * line uses and what every display ROM and pixel-perfect E2E was built
   * against. `demake build` asks for another where a *game* is better served by
   * it — the GBA's 256-colour tiled mode against its sixteen-palette one.
   */
  mode?: number;
  /** Force raw lattice-expansion colors in the output (the default for panel-filter consoles). */
  rawColors?: boolean;
  /** Force DAC-simulated display colors in the output (`--dac-colors`). */
  dacColors?: boolean;
  onProgress?: (stage: string, fraction: number) => void;
  signal?: AbortSignalLike;
  /**
   * Where the tournament's candidates run (doc 04 §Running the tournament).
   *
   * Candidates cannot see each other, so an edge with threads to spare can hand
   * one in: the CLI's runs on `worker_threads`, the page's on Web Workers.
   * Omitted, they run on this thread in order — same conversion, same bytes,
   * just the one core.
   */
  executor?: Executor;
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

/**
 * What the source turned out to be, once the engine had decoded it.
 *
 * Reported rather than left to be guessed, because for a vector source there is
 * nothing to guess *from*: an `<svg>` carries a coordinate system and, if its
 * author bothered, a declared size, and a host that measures one by putting it
 * in an `<img>` gets the CSS answer — 300×150 for a document with only a
 * `viewBox`, which is not the raster the pipeline fitted. So the size here is
 * the decoder's own, and `vector` says whether it was a choice or a fact.
 */
export interface SourceInfo {
  /** The container the bytes turned out to be. */
  format: ImageFormat;
  /** The raster the pipeline actually fitted from, in pixels. */
  width: number;
  height: number;
  /**
   * Whether the source had no pixels of its own.
   *
   * True for SVG, where {@link width} and {@link height} are the size the
   * rasteriser was asked for rather than a property of the file — so scaling up
   * costs nothing and loses nothing, which is the opposite of every other format
   * here.
   */
  vector: boolean;
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
  /** What went in, as the engine decoded it — never as a host measured it. */
  source: SourceInfo;
  decisions: AutoDecisions;
  stats: FitStats;
  warnings: Warning[];
  tournament: { winner: string; candidates: CandidateScore[] };
}
