/**
 * `demake gen` — the code-generation command (doc 05, doc 06, doc 16).
 *
 * Turns an image into console data/code. A compliant image (or a pinned
 * manifest) takes the lossless exact path; anything else is implicitly prepped
 * first (unless `--strict`). Emits one file per artifact under an output stem
 * (`-o`), or a single `asm` blob to stdout when piped. `--json` reports every
 * file written with byte sizes and content hashes (doc 06 §Output hygiene).
 *
 * It also takes a **chip schedule** — what `arrange --emit-manifest` and
 * `sfx --emit-manifest` write — and builds a cartridge that plays it. `gen`
 * extends rather than forks because its job is already "emit code for this
 * console" (doc 16 §CLI surface), and the dispatch is on what the input *is*,
 * exactly as the image path already dispatches on a compliant PNG.
 */

import { buildAudioRom, AudioRomError, type AudioRomStats, type ChipScript } from "@demake/audio";
import {
  gen,
  getConsole,
  sourceHash,
  type CodegenFormat,
  type GenArtifact,
  type GenResult,
} from "@demake/core";
import type { ParsedValue } from "@demake/cli-spec";

import type { CliEnv } from "../env.js";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { CliError, resolveInput } from "../io.js";
import { readChipScript } from "./audio.js";
import { romBuilderFor } from "../rom/registry.js";

function str(values: Record<string, ParsedValue>, key: string): string | undefined {
  return typeof values[key] === "string" ? (values[key] as string) : undefined;
}

function int(values: Record<string, ParsedValue>, key: string): number | undefined {
  return typeof values[key] === "number" ? (values[key] as number) : undefined;
}

/** Strip a known generated-artifact extension to get a stem for multi-file output. */
function stripExt(path: string): string {
  return path.replace(/\.(asm|c|h|bin|gb|gbc)$/i, "");
}

/** Derive the default output stem from the source name (or `out`). */
function stemFromSource(source: string): string {
  if (source === "<stdin>") return "out";
  const base = source.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : "out";
}

interface WrittenFile {
  path: string;
  bytes: number;
  hash: string;
}

export async function runGen(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  positionals: string[],
): Promise<ExitCode> {
  const json = values.json === true;
  const quiet = values.quiet === true;
  const force = values.force === true;
  const consoleId = str(values, "console");
  if (!consoleId) {
    throw new CliError(
      EXIT.USAGE,
      "E_MISSING_CONSOLE",
      "missing required --console",
      "e.g. --console gbc",
    );
  }

  const { bytes, source } = resolveInput(env, positionals);
  const format = (str(values, "format") ?? "asm") as CodegenFormat;
  const output = str(values, "output");

  const schedule = readChipScript(bytes);
  if (schedule) {
    return runAudioGen(env, values, schedule, source, format, output);
  }

  let manifest: Uint8Array | undefined;
  const manifestPath = str(values, "manifest");
  if (manifestPath !== undefined) {
    try {
      manifest = env.readFile(manifestPath);
    } catch {
      throw new CliError(EXIT.NO_INPUT, "E_NO_INPUT", `cannot read manifest '${manifestPath}'`);
    }
  }

  // `rom` is assembled at this edge: core produces the data, the family's
  // toolchain the ROM. The GB harness consumes `asm` (with a fixed symbol);
  // every other harness includes the `bin` blobs verbatim.
  const wantRom = format === "rom";
  const romBuilder = wantRom ? romBuilderFor(getConsole(consoleId)) : undefined;
  const coreFormat: CodegenFormat = wantRom ? (romBuilder?.format ?? "bin") : format;
  const userSymbol = str(values, "symbol");
  if (wantRom && userSymbol !== undefined && !quiet) {
    env.errOut("demake: warning: --symbol is ignored for --format rom (the harness pins it).\n");
  }

  const optionString = buildOptionString(consoleId, format, values);
  const result: GenResult = await gen(bytes, {
    console: consoleId,
    format: coreFormat,
    ...(wantRom ? { symbol: "demake" } : userSymbol !== undefined ? { symbol: userSymbol } : {}),
    strict: values.strict === true,
    ...(int(values, "tile-base") !== undefined ? { tileBase: int(values, "tile-base")! } : {}),
    ...(int(values, "map-base") !== undefined ? { mapBase: int(values, "map-base")! } : {}),
    ...(manifest ? { manifest } : {}),
    sourceName: source,
    optionString,
    command: `demake gen ${source === "<stdin>" ? "-" : source} ${optionString}`,
  });

  let artifacts = result.artifacts;
  if (wantRom) {
    const spec = getConsole(consoleId);
    if (!spec.codegen.formats.includes("rom")) {
      throw new CliError(
        EXIT.USAGE,
        "E_UNSUPPORTED_OUTPUT",
        `${spec.id} does not support --format rom`,
      );
    }
    if (!romBuilder) {
      throw new CliError(
        EXIT.UNAVAILABLE,
        "E_TOOLCHAIN_MISSING",
        `rom building for the '${spec.codegen.family}' family is not implemented yet`,
      );
    }
    const rom = romBuilder.build(env, spec, result);
    artifacts = [{ suffix: romBuilder.suffix(spec), kind: "rom", bytes: rom }];
  }

  const written = writeArtifacts(env, artifacts, output, source, force, json);

  if (json) {
    env.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          console: consoleId,
          format,
          path: result.path,
          stats: result.stats,
          files: written,
          warnings: result.warnings,
        },
        null,
        2,
      ) + "\n",
    );
  } else if (!quiet) {
    for (const w of result.warnings) env.errOut(`demake: warning: ${w.message}\n`);
  }
  return EXIT.OK;
}

/**
 * Build a cartridge from a chip schedule (doc 16 §The driver contract).
 *
 * The console comes from the *schedule*, not the flag: a schedule was fitted to
 * one console's channels, lattice and driver clock, so building it for another
 * would be a different arrangement rather than a different output format. A
 * mismatched `--console` therefore says what to re-run instead of quietly
 * emitting something the user did not ask for.
 */
async function runAudioGen(
  env: CliEnv,
  values: Record<string, ParsedValue>,
  script: ChipScript,
  source: string,
  format: CodegenFormat,
  output: string | undefined,
): Promise<ExitCode> {
  const json = values.json === true;
  const asked = str(values, "console");
  if (asked && getConsole(asked).id !== getConsole(script.console).id) {
    throw new CliError(
      EXIT.USAGE,
      "E_CONSOLE_MISMATCH",
      `this schedule was arranged for ${script.console}, not ${asked}`,
      `re-run arrange/sfx with --console ${asked} to fit the track to that hardware.`,
    );
  }
  if (format !== "rom") {
    throw new CliError(
      EXIT.UNAVAILABLE,
      "E_UNSUPPORTED_OUTPUT",
      `--format ${format} is not available for a chip schedule yet`,
      "the driver is generated machine code, so `--format rom` is the format that exists today (doc 16 §The driver contract); `demake render` writes the exact audio.",
    );
  }

  let built: Awaited<ReturnType<typeof buildAudioRom>>;
  try {
    built = await buildAudioRom(script, { title: titleFor(output ?? source) });
  } catch (error) {
    if (error instanceof AudioRomError) {
      throw new CliError(EXIT.FAILURE, error.code, error.message, error.hint);
    }
    throw error;
  }

  const written = writeArtifacts(
    env,
    [{ suffix: built.suffix, kind: "rom", bytes: built.bytes }],
    output,
    source,
    values.force === true,
    json,
  );

  if (json) {
    const stats: AudioRomStats = built.stats;
    env.out(
      JSON.stringify(
        { schemaVersion: 1, console: script.console, format, stats, files: written },
        null,
        2,
      ) + "\n",
    );
  } else if (values.quiet !== true && built.stats.ratePpmError !== 0) {
    env.errOut(
      `demake: warning: the driver clock is ${built.stats.ratePpmError} ppm from the schedule's rate.\n`,
    );
  }
  return EXIT.OK;
}

/** A cartridge title from the output or input name — no flag needed for it. */
function titleFor(path: string): string {
  const base = path.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : "DEMAKE";
}

/** Write artifacts to files (or a single asm blob to stdout when piped). */
function writeArtifacts(
  env: CliEnv,
  artifacts: readonly GenArtifact[],
  output: string | undefined,
  source: string,
  force: boolean,
  json: boolean,
): WrittenFile[] {
  const single = artifacts.length === 1;

  // Convenience: a single text artifact with no -o goes to stdout when piped.
  if (single && output === undefined && !json && !env.stdoutIsTTY()) {
    env.writeStdout(artifacts[0]!.bytes);
    return [
      {
        path: "<stdout>",
        bytes: artifacts[0]!.bytes.length,
        hash: sourceHash(artifacts[0]!.bytes),
      },
    ];
  }

  const written: WrittenFile[] = [];
  const writeTo = (path: string, a: GenArtifact): void => {
    try {
      env.writeFileAtomic(path, a.bytes, force);
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        throw new CliError(
          EXIT.CANNOT_CREATE,
          "E_OUTPUT_EXISTS",
          `output '${path}' exists`,
          "pass --force to overwrite.",
        );
      }
      throw new CliError(EXIT.CANNOT_CREATE, "E_CANNOT_CREATE", `cannot write '${path}'`);
    }
    written.push({ path, bytes: a.bytes.length, hash: sourceHash(a.bytes) });
  };

  if (single && output !== undefined) {
    writeTo(output, artifacts[0]!);
    return written;
  }

  const stem = output !== undefined ? stripExt(output) : stemFromSource(source);
  for (const a of artifacts) writeTo(stem + a.suffix, a);
  return written;
}

function buildOptionString(
  consoleId: string,
  format: string,
  values: Record<string, ParsedValue>,
): string {
  const parts = [`--console ${consoleId}`, `--format ${format}`];
  const symbol = str(values, "symbol");
  if (symbol) parts.push(`--symbol ${symbol}`);
  if (values.strict === true) parts.push("--strict");
  const tileBase = int(values, "tile-base");
  if (tileBase) parts.push(`--tile-base ${tileBase}`);
  const mapBase = int(values, "map-base");
  if (mapBase) parts.push(`--map-base ${mapBase}`);
  const manifest = str(values, "manifest");
  if (manifest) parts.push(`--manifest ${manifest}`);
  return parts.join(" ");
}
