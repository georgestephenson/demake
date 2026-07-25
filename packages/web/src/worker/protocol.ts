/**
 * The worker protocol (doc 07 §Stack).
 *
 * The UI thread never touches `@demake/core`: every conversion crosses this
 * message boundary, so a long `--effort max` run can't stall the page. Payloads
 * are plain data plus `ArrayBuffer`s (transferred, not copied), which is also why
 * the worker returns *rendered* previews rather than a `CompliantImage` full of
 * typed-array views.
 */

import type { AutoDecisions, CandidateScore, FitStats, StrategyInfo, Warning } from "@demake/core";

/** The option set the UI edits — one field per `demake prep` flag (doc 05). */
export interface PrepOptionsUi {
  console: string;
  strategy: string;
  size: string; // "" = auto, else "WxH"
  fit: "contain" | "cover" | "stretch" | "pad";
  scale: "auto" | "majority" | "lanczos3" | "box" | "nearest";
  dither: string; // "" = auto, else "<alg>" or "<alg>:<strength>"
  profile: "auto" | "art" | "photo";
  effort: "fast" | "default" | "max";
  metric: "oklab" | "wrgb";
  seed: string; // "" = default seed
  background: string;
  protect: string; // comma-separated colors; "" = auto
  noProtect: boolean;
  rawColors: boolean;
  dacColors: boolean;
  strict: boolean;
}

/** A rendered preview surface (RGBA, row-major). */
export interface Surface {
  width: number;
  height: number;
  data: ArrayBuffer;
}

/** One fitted sub-palette, flattened for the palette strip. */
export interface PaletteSwatches {
  /** `#rrggbb` per entry, in fitted order. */
  colors: string[];
}

/** Everything a conversion produces for the UI. */
export interface PrepPayload {
  png: ArrayBuffer;
  manifest: ArrayBuffer;
  /** Author-space render (what the PNG stores). */
  raw: Surface;
  /** DAC-simulated render (what the hardware screen shows). */
  dac: Surface;
  palettes: PaletteSwatches[];
  decisions: AutoDecisions;
  stats: FitStats;
  warnings: Warning[];
  tournament: { winner: string; candidates: CandidateScore[] };
  /** Milliseconds the worker spent inside `prep` (UI feedback only). */
  elapsedMs: number;
}

/** A generated code artifact, ready to download. */
export interface GenArtifactPayload {
  name: string;
  kind: "asm" | "c" | "header" | "bin" | "rom";
  bytes: ArrayBuffer;
}

/** Console metadata the picker needs (derived from the spec, never hard-coded). */
export interface ConsoleInfo {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
  width: number;
  height: number;
  /** One-line constraint summary, e.g. "160×144 · 8 palettes × 4 colors". */
  summary: string;
  /** Formats `gen` can emit for this console. */
  formats: string[];
  /** Whether a codegen backend is registered (i.e. `gen` works at all). */
  hasCodegen: boolean;
  pixelAspect: [number, number];
}

export type WorkerRequest =
  | { id: number; kind: "consoles" }
  | { id: number; kind: "strategies"; console: string }
  | { id: number; kind: "demo" }
  | { id: number; kind: "prep"; source: ArrayBuffer; options: PrepOptionsUi }
  | {
      id: number;
      kind: "gen";
      source: ArrayBuffer;
      options: PrepOptionsUi;
      format: "asm" | "c" | "bin";
      stem: string;
    };

export type WorkerResponse =
  | { id: number; ok: true; kind: "consoles"; consoles: ConsoleInfo[] }
  | { id: number; ok: true; kind: "strategies"; strategies: StrategyInfo[] }
  | { id: number; ok: true; kind: "demo"; png: ArrayBuffer }
  | { id: number; ok: true; kind: "prep"; result: PrepPayload }
  | { id: number; ok: true; kind: "gen"; artifacts: GenArtifactPayload[] }
  | { id: number; ok: false; code: string; message: string; hint?: string }
  | { id: number; progress: { stage: string; fraction: number } };
