/**
 * `gen` — the code-generation orchestrator (doc 06).
 *
 * Turns an image into console artifacts. Two input paths reach the same emitter
 * (doc 06 §Input paths):
 *
 *  1. **Exact path** — a supplied manifest (pinned order) or the detector proves
 *     the pixels are already compliant, and conversion is lossless.
 *  2. **Implicit prep** — otherwise the full `prep` pipeline runs first, then the
 *     exact path. `strict` disables the fallback and fails on non-compliant input.
 *
 * Everything here is platform-pure: the result is in-memory artifact bytes. The
 * `rom` format (which needs an assembler) is refused in core with a clear
 * `E_TOOLCHAIN_MISSING`; the CLI's toolchain edge owns that build (doc 06 §ROM
 * building).
 */

import { DemakeError } from "../errors.js";
import { decodeImage } from "../image/decode.js";
import { getConsole } from "../consoles/registry.js";
import { checkCompliantImage } from "../inspect/inspect.js";
import { prep } from "../pipeline/prep.js";
import type { CompliantImage, PrepOptions, Warning } from "../pipeline/types.js";
import type { CodegenFormat, TileLayout } from "../consoles/types.js";

import { detectCompliant } from "./detect.js";
import { applyManifest, parseManifest } from "./manifest.js";
import { buildHeader } from "./provenance.js";
import { backendFor } from "./registry.js";
import { extractTiles } from "./tiles.js";
import type { EmitOptions, GenArtifact } from "./types.js";

/** How `gen` arrived at a compliant image. */
export type GenPath = "compliant" | "manifest" | "prepped";

/** Options for {@link gen}. */
export interface GenOptions {
  console: string;
  /** Output format (default `asm`). `rom` requires the toolchain edge. */
  format?: CodegenFormat;
  /** Identifier/label prefix for `asm`/`c` (default derived from the console). */
  symbol?: string;
  /** Fail on non-compliant input instead of running implicit prep. */
  strict?: boolean;
  /** Value added to emitted map tile indices (VRAM tile offset). */
  tileBase?: number;
  /** Map origin offset, recorded in provenance / used by the ROM harness. */
  mapBase?: number;
  /** A manifest sidecar (JSON bytes) to pin palette order. */
  manifest?: Uint8Array;
  /** Options forwarded to implicit `prep` (path 2). */
  prep?: Omit<PrepOptions, "console">;
  /** A human label for the source image (path or `<stdin>`). */
  sourceName?: string;
  /** The full resolved option string, for the provenance header. */
  optionString?: string;
  /** The command that reproduces this run, for the "regenerate with" line. */
  command?: string;
}

/** Result of {@link gen}. */
export interface GenResult {
  artifacts: GenArtifact[];
  image: CompliantImage;
  path: GenPath;
  format: CodegenFormat;
  stats: { tiles: number; cells: number; palettes: number; tileBudget: number | null };
  warnings: Warning[];
}

const VALID_SYMBOL = /[^A-Za-z0-9_]/g;

function defaultSymbol(sourceName: string | undefined, consoleId: string): string {
  const base = sourceName
    ? sourceName.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "")
    : `${consoleId}_gfx`;
  const cleaned = base.replace(VALID_SYMBOL, "_").replace(/^_+/, "");
  const s = cleaned.length > 0 ? cleaned : `${consoleId}_gfx`;
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

/** Generate console artifacts from an image (doc 06). */
export async function gen(input: Uint8Array, options: GenOptions): Promise<GenResult> {
  const spec = getConsole(options.console);
  const format: CodegenFormat = options.format ?? "asm";
  const warnings: Warning[] = [];

  const backend = backendFor(spec.codegen.family);
  if (!backend) {
    throw new DemakeError(
      "E_UNSUPPORTED_FAMILY",
      `no codegen backend for family '${spec.codegen.family}' (console ${spec.id})`,
      { hint: "this console's backend lands in a later tier; see docs/06-codegen-spec.md." },
    );
  }
  if (!spec.codegen.formats.includes(format)) {
    throw new DemakeError(
      "E_UNSUPPORTED_OUTPUT",
      `${spec.id} does not support --format ${format}`,
      {
        hint: `supported: ${spec.codegen.formats.join(", ")}`,
      },
    );
  }
  if (format === "rom") {
    throw new DemakeError(
      "E_TOOLCHAIN_MISSING",
      `building a rom needs the ${spec.codegen.family} assembler`,
      {
        hint: "emit bin/asm/c and assemble with the family toolchain (doc 06 §ROM building).",
      },
    );
  }

  // --- reach a compliant image ------------------------------------------------
  let image: CompliantImage;
  let path: GenPath;
  if (options.manifest) {
    const decoded = decodeImage(input);
    image = applyManifest(decoded, spec, parseManifest(options.manifest), input);
    path = "manifest";
  } else {
    const decoded = decodeImage(input);
    const detected = detectCompliant(decoded, spec);
    if (detected) {
      image = detected;
      path = "compliant";
    } else if (options.strict) {
      throw new DemakeError(
        "E_STRICT_NONCOMPLIANT",
        `input is not already compliant for ${spec.id}`,
        {
          hint: "run 'demake inspect' to see why, drop --strict to let gen prep it, or prep it first.",
        },
      );
    } else {
      const result = await prep(input, { console: options.console, ...options.prep });
      image = result.image;
      path = "prepped";
      warnings.push(...result.warnings);
    }
  }

  // A last structural check — the emitter must never see an invalid image.
  const violations = checkCompliantImage(image, spec);
  if (violations.length > 0) {
    throw new DemakeError(
      "E_INTERNAL",
      `compliance check failed: ${violations.map((v) => v.code).join(",")}`,
    );
  }

  // --- emit -------------------------------------------------------------------
  const emitOpts: EmitOptions = {
    symbol: options.symbol ?? defaultSymbol(options.sourceName, spec.id),
    header: buildHeader({
      consoleId: spec.id,
      consoleName: spec.name,
      format,
      source: input,
      ...(options.sourceName !== undefined ? { sourceName: options.sourceName } : {}),
      ...(options.optionString !== undefined ? { options: options.optionString } : {}),
      path,
      ...(options.command !== undefined ? { command: options.command } : {}),
    }),
    mapBase: options.mapBase ?? 0,
    tileBase: options.tileBase ?? 0,
  };

  const artifacts =
    format === "bin"
      ? backend.emitBin(image, spec, emitOpts)
      : format === "c"
        ? backend.emitC(image, spec, emitOpts)
        : backend.emitAsm(image, spec, emitOpts);

  // Stats: unique tiles vs the VRAM budget (a warning, not a hard failure here —
  // prep's budget stage is the enforcer; a hand-authored compliant input might
  // legitimately exceed it and the developer should be told).
  const layout = spec.layout as TileLayout;
  const tiled = extractTiles(image, layout);
  const budget = layout.tileBudget ?? null;
  if (budget !== null && tiled.tiles.length > budget) {
    warnings.push({
      code: "W_TILE_BUDGET",
      message: `${tiled.tiles.length} unique tiles exceed the ${spec.id} budget of ${budget}`,
    });
  }

  return {
    artifacts,
    image,
    path,
    format,
    stats: {
      tiles: tiled.tiles.length,
      cells: tiled.map.length,
      palettes: image.palettes.length,
      tileBudget: budget,
    },
    warnings,
  };
}
