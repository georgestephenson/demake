/**
 * `demake gen` — the code-generation command (doc 05, doc 06).
 *
 * Turns an image into console data/code. A compliant image (or a pinned
 * manifest) takes the lossless exact path; anything else is implicitly prepped
 * first (unless `--strict`). Emits one file per artifact under an output stem
 * (`-o`), or a single `asm` blob to stdout when piped. `--json` reports every
 * file written with byte sizes and content hashes (doc 06 §Output hygiene).
 */

import {
  gen,
  sourceHash,
  type CodegenFormat,
  type GenArtifact,
  type GenResult,
} from "@demake/core";
import type { ParsedValue } from "@demake/cli-spec";

import type { CliEnv } from "../env.js";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { CliError, resolveInput } from "../io.js";

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

  let manifest: Uint8Array | undefined;
  const manifestPath = str(values, "manifest");
  if (manifestPath !== undefined) {
    try {
      manifest = env.readFile(manifestPath);
    } catch {
      throw new CliError(EXIT.NO_INPUT, "E_NO_INPUT", `cannot read manifest '${manifestPath}'`);
    }
  }

  const optionString = buildOptionString(consoleId, format, values);
  const result: GenResult = await gen(bytes, {
    console: consoleId,
    format,
    ...(str(values, "symbol") !== undefined ? { symbol: str(values, "symbol")! } : {}),
    strict: values.strict === true,
    ...(int(values, "tile-base") !== undefined ? { tileBase: int(values, "tile-base")! } : {}),
    ...(int(values, "map-base") !== undefined ? { mapBase: int(values, "map-base")! } : {}),
    ...(manifest ? { manifest } : {}),
    sourceName: source,
    optionString,
    command: `demake gen ${source === "<stdin>" ? "-" : source} ${optionString}`,
  });

  const written = writeArtifacts(env, result.artifacts, output, source, force, json);

  if (json) {
    env.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          console: consoleId,
          format: result.format,
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
