/**
 * `demake prep` — the conversion command (doc 05).
 *
 * Builds {@link PrepOptions} from parsed flags, runs the core pipeline, and
 * emits the winning image per the prime-directive rules. `--json` adds the
 * tournament scoreboard, chosen defaults, and stats; `--strategy list` short-
 * circuits to enumerate candidates; `--emit-manifest` and `--preview` are opt-in
 * side artifacts.
 */

import {
  buildManifest,
  decodePng,
  encodeManifest,
  encodeRgbaPng,
  prep,
  sourceHash,
  strategies,
  type DitherAlg,
  type PrepOptions,
  type ScaleKernel,
} from "@demake/core";
import type { ParsedValue } from "@demake/cli-spec";

import type { CliEnv } from "../env.js";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { CliError, emitProduct, resolveInput } from "../io.js";

const DITHERS: readonly DitherAlg[] = [
  "none",
  "bayer2",
  "bayer4",
  "bayer8",
  "floyd-steinberg",
  "atkinson",
  "riemersma",
  "ramp",
];

function str(values: Record<string, ParsedValue>, key: string): string | undefined {
  return typeof values[key] === "string" ? (values[key] as string) : undefined;
}

/** Parse `--dither alg[:strength]` into the core option shape. */
function parseDither(raw: string): { alg: DitherAlg; strength?: number } {
  const [algPart, strengthPart] = raw.split(":");
  const alg = algPart as DitherAlg;
  if (!DITHERS.includes(alg)) {
    throw new CliError(
      EXIT.USAGE,
      "E_INVALID_OPTION",
      `unknown dither '${algPart}'`,
      `one of: ${DITHERS.join(", ")}`,
    );
  }
  if (strengthPart === undefined) return { alg };
  const strength = Number(strengthPart);
  if (!Number.isFinite(strength) || strength < 0 || strength > 100) {
    throw new CliError(EXIT.USAGE, "E_INVALID_OPTION", `dither strength must be 0-100`);
  }
  return { alg, strength };
}

function buildOptions(values: Record<string, ParsedValue>): PrepOptions {
  const options: PrepOptions = { console: str(values, "console")! };
  const size = values.size as { w: number; h: number } | undefined;
  if (size) options.size = size;
  const scale = str(values, "scale");
  if (scale && scale !== "auto") options.scale = scale as ScaleKernel;
  const dither = str(values, "dither");
  if (dither) options.dither = parseDither(dither);
  const profile = str(values, "profile");
  if (profile && profile !== "auto") options.profile = profile as "art" | "photo";
  const effort = str(values, "effort");
  if (effort) options.effort = effort as "fast" | "default" | "max";
  const strategy = str(values, "strategy");
  if (strategy) options.strategy = strategy;
  if (typeof values.seed === "number") options.seed = values.seed;
  const background = str(values, "background");
  if (background) options.background = background;
  if (Array.isArray(values.protect)) options.protect = values.protect;
  if (values["no-protect"] === true) options.protect = false;
  if (values.strict === true) options.strict = true;
  if (values["raw-colors"] === true && values["dac-colors"] === true) {
    throw new CliError(
      EXIT.USAGE,
      "E_INVALID_OPTION",
      "--raw-colors and --dac-colors are mutually exclusive",
    );
  }
  if (values["raw-colors"] === true) options.rawColors = true;
  if (values["dac-colors"] === true) options.dacColors = true;
  return options;
}

export async function runPrep(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  positionals: string[],
): Promise<ExitCode> {
  const json = values.json === true;
  const quiet = values.quiet === true;
  const verbose = (typeof values.verbose === "number" ? values.verbose : 0) > 0;
  const consoleId = str(values, "console");
  if (!consoleId) {
    throw new CliError(
      EXIT.USAGE,
      "E_MISSING_CONSOLE",
      "missing required --console",
      "e.g. --console gbc",
    );
  }

  // --strategy list short-circuits (no input needed).
  if (str(values, "strategy") === "list") {
    const list = strategies(consoleId);
    if (json) {
      env.out(
        JSON.stringify({ schemaVersion: 1, console: consoleId, strategies: list }, null, 2) + "\n",
      );
    } else {
      for (const s of list) env.out(`  ${s.id}  (${s.scale}, ${s.dither})  — ${s.description}\n`);
    }
    return EXIT.OK;
  }

  const { bytes } = resolveInput(env, positionals);
  const options = buildOptions(values);
  if (str(values, "metric") === "wrgb" && !quiet) {
    env.errOut("demake: warning: --metric wrgb is not implemented yet; using oklab.\n");
  }

  const result = await prep(bytes, options);
  const output = str(values, "output");
  const emit = emitProduct(env, result.png, output, values.force === true, json);

  // Optional side artifacts.
  const previewSpec = str(values, "preview");
  if (previewSpec) writePreview(env, result.image, result.png, previewSpec, values.force === true);
  const manifestPath = manifestTarget(values);
  if (manifestPath !== undefined) {
    env.writeFileAtomic(
      manifestPath || defaultManifestPath(output),
      encodeManifest(buildManifest(result, sourceHash(result.png))),
      values.force === true,
    );
  }

  if (json) {
    env.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          output: emit.wroteTo,
          decisions: result.decisions,
          stats: result.stats,
          warnings: result.warnings,
          tournament: result.tournament,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    if (!quiet) {
      for (const w of result.warnings) env.errOut(`demake: warning: ${w.message}\n`);
    }
    if (verbose) {
      const d = result.decisions;
      env.errOut(
        `demake: winner=${d.strategy} profile=${d.profile} size=${d.size.w}x${d.size.h} ` +
          `scale=${d.scale} dither=${d.dither.alg} meanΔE=${result.stats.meanDeltaE.toFixed(4)}\n`,
      );
    }
  }
  return EXIT.OK;
}

function manifestTarget(values: Record<string, ParsedValue>): string | undefined {
  const v = values["emit-manifest"];
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : "";
}

function defaultManifestPath(output: string | undefined): string {
  if (output) return output.replace(/\.png$/i, "") + ".json";
  return "manifest.json";
}

/** Write an N× nearest-neighbor preview PNG (`--preview file[@N]`). */
function writePreview(
  env: CliEnv,
  image: { width: number; height: number },
  png: Uint8Array,
  spec: string,
  force: boolean,
): void {
  const at = spec.lastIndexOf("@");
  const path = at >= 0 ? spec.slice(0, at) : spec;
  const scale = at >= 0 ? Math.max(1, Number(spec.slice(at + 1)) || 1) : 6;
  // Re-decode our own PNG to RGBA and upscale nearest.
  // (Kept simple: the primary artifact is `png`; the preview is a convenience.)
  const decoded = decodePng(png);
  const w = decoded.width * scale;
  const h = decoded.height * scale;
  const up = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.floor(x / scale);
      const sy = Math.floor(y / scale);
      const si = (sy * decoded.width + sx) * 4;
      const di = (y * w + x) * 4;
      up[di] = decoded.data[si]!;
      up[di + 1] = decoded.data[si + 1]!;
      up[di + 2] = decoded.data[si + 2]!;
      up[di + 3] = 255;
    }
  }
  void image;
  env.writeFileAtomic(path, encodeRgbaPng(w, h, up), force);
}
