/**
 * The worker protocol (doc 07 §Stack).
 *
 * The UI thread never touches `@demake/core`: every conversion crosses this
 * message boundary, so a long `--effort max` run can't stall the page. Payloads
 * are plain data plus `ArrayBuffer`s (transferred, not copied), which is also why
 * the worker returns *rendered* previews rather than a `CompliantImage` full of
 * typed-array views.
 *
 * Building a cartridge crosses it too, and for both reasons at once: a game's
 * art is demade by the same engine, so the build is seconds of arithmetic that
 * must not run on the UI thread — and putting it here means the image engine is
 * bundled once for the whole site rather than once per thread that wanted it.
 */

import type {
  AutoDecisions,
  CandidateScore,
  FitStats,
  Job,
  JobOutcome,
  StrategyInfo,
  Warning,
} from "@demake/core";
import type { Layout, Program } from "@demake/demotic";

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

/**
 * A cartridge, and the facts about it the pane needs before it can show one.
 *
 * `console` and `extension` come back with the ROM rather than being asked for
 * separately, because the pane keeps playing the last cartridge while the next
 * one demakes and everything it displays has to describe the one on screen.
 * `family` is which of the three cores boots it — the registry's answer, not a
 * table the page keeps.
 *
 * `unsupported` names what this console's backend cannot compile. It is the
 * one outcome that is neither a ROM nor an error: the game is fine and the
 * preview plays it correctly, so the pane says what is missing instead of
 * handing over a cartridge that would play something else.
 */
export interface BuiltRomPayload {
  console: string;
  family: string;
  extension: string;
  unsupported: string[];
  /** Absent exactly when `unsupported` is non-empty. */
  rom?: ArrayBuffer;
  layout?: Layout;
}

export type WorkerRequest =
  | { id: number; kind: "consoles" }
  /**
   * One unit of a tournament, run here rather than on the worker that wanted it
   * (doc 04 §Running the tournament).
   *
   * Every instance of this worker holds both engines — it builds cartridges, and
   * a cartridge's art and audio are demade through them — so an extra instance is
   * a pool lane at no download cost, and needs no message but this one.
   */
  | { id: number; kind: "job"; job: Job }
  /**
   * The lanes, handed over once before the first build.
   *
   * Ports rather than workers, because the far end of each belongs to a lane the
   * *page* started: candidates then travel straight between this worker and the
   * lane, with neither the main thread relaying them nor a worker spawning
   * workers of its own.
   */
  | { id: number; kind: "lanes"; ports: MessagePort[] }
  /**
   * The other side of that channel: a port to *answer* jobs on.
   *
   * A worker is told one or the other and never both, which is what makes the
   * fan-out one level deep — a lane has no lanes, so a job it runs cannot fan
   * out again.
   */
  | { id: number; kind: "serve"; port: MessagePort }
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
    }
  | {
      id: number;
      kind: "build-game";
      /**
       * The compiled program, structured-cloned across the boundary.
       *
       * Plain resolved data by construction (doc 14 §Runtime model) — indices,
       * numbers and 16.16 literals, no functions and no class instances — which
       * is what makes sending it cheaper and safer than sending the source and
       * compiling twice.
       */
      program: Program;
      title: string;
      /** Every asset the program names, as the *source* bytes it was given. */
      assets: Map<string, Uint8Array>;
    };

export type WorkerResponse =
  | { id: number; ok: true; kind: "consoles"; consoles: ConsoleInfo[] }
  | { id: number; ok: true; kind: "job"; outcome: JobOutcome }
  | { id: number; ok: true; kind: "lanes" }
  | { id: number; ok: true; kind: "serve" }
  | { id: number; ok: true; kind: "strategies"; strategies: StrategyInfo[] }
  | { id: number; ok: true; kind: "demo"; png: ArrayBuffer }
  | { id: number; ok: true; kind: "prep"; result: PrepPayload }
  | { id: number; ok: true; kind: "gen"; artifacts: GenArtifactPayload[] }
  | { id: number; ok: true; kind: "build-game"; result: BuiltRomPayload }
  | { id: number; ok: false; code: string; message: string; hint?: string }
  | { id: number; progress: { stage: string; fraction: number } };
