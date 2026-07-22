/**
 * Shared command helpers: input resolution, product emission, error reporting.
 *
 * Encodes the "prime directive" (doc 05): one image in, one image out. Product
 * goes to `-o`, or to stdout when stdout is piped; binary to a TTY without `-o`
 * is refused. In `--json` mode the product goes to the `-o` file and the JSON
 * object is the only thing on stdout. Everything is expressed against
 * {@link CliEnv} so it is fully testable.
 */

import { DemakeError } from "@demake/core";

import type { CliEnv } from "./env.js";
import { EXIT, type ExitCode } from "./exit-codes.js";

/** A CLI-level failure carrying an exit code and structured payload. */
export class CliError extends Error {
  constructor(
    readonly exit: ExitCode,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Resolve the input bytes from a positional path, `-`, or piped stdin. */
export function resolveInput(
  env: CliEnv,
  positionals: string[],
): { bytes: Uint8Array; source: string } {
  const first = positionals[0];
  if (first !== undefined && first !== "-") {
    try {
      return { bytes: env.readFile(first), source: first };
    } catch {
      throw new CliError(
        EXIT.NO_INPUT,
        "E_NO_INPUT",
        `cannot read input '${first}'`,
        "check the path exists and is readable.",
      );
    }
  }
  // Explicit '-' or no path: read stdin if it is piped.
  const stdin = env.readStdin();
  if (stdin && stdin.length > 0) {
    return { bytes: stdin, source: "<stdin>" };
  }
  throw new CliError(
    EXIT.NO_INPUT,
    "E_NO_INPUT",
    "no input image given",
    "pass a file path, or pipe an image to stdin.",
  );
}

/** Emit the binary product per the prime-directive rules. */
export function emitProduct(
  env: CliEnv,
  bytes: Uint8Array,
  outputPath: string | undefined,
  force: boolean,
  jsonMode: boolean,
): { wroteTo: string | null } {
  if (outputPath) {
    try {
      env.writeFileAtomic(outputPath, bytes, force);
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        throw new CliError(
          EXIT.CANNOT_CREATE,
          "E_OUTPUT_EXISTS",
          `output '${outputPath}' exists`,
          "pass --force to overwrite.",
        );
      }
      throw new CliError(EXIT.CANNOT_CREATE, "E_CANNOT_CREATE", `cannot write '${outputPath}'`);
    }
    return { wroteTo: outputPath };
  }
  if (jsonMode) {
    // Product is suppressed on stdout in JSON mode (JSON owns stdout).
    return { wroteTo: null };
  }
  if (env.stdoutIsTTY()) {
    throw new CliError(
      EXIT.USAGE,
      "E_BINARY_TO_TTY",
      "refusing to write binary image to a terminal",
      "pass -o <file> or redirect stdout to a pipe/file.",
    );
  }
  env.writeStdout(bytes);
  return { wroteTo: "<stdout>" };
}

/** Print a structured error to stderr (JSON when requested) and return its exit. */
export function reportError(env: CliEnv, error: unknown, jsonMode: boolean): ExitCode {
  if (error instanceof CliError) {
    printError(env, jsonMode, error.code, error.message, error.hint);
    return error.exit;
  }
  if (error instanceof DemakeError) {
    printError(env, jsonMode, error.code, error.message, error.hint, error.docs);
    return mapDemakeExit(error.code);
  }
  const message = error instanceof Error ? error.message : String(error);
  printError(env, jsonMode, "E_INTERNAL", message);
  return EXIT.INTERNAL;
}

function printError(
  env: CliEnv,
  jsonMode: boolean,
  code: string,
  message: string,
  hint?: string,
  docs?: string,
): void {
  if (jsonMode) {
    env.errOut(
      JSON.stringify({
        error: { code, message, ...(hint ? { hint } : {}), ...(docs ? { docs } : {}) },
      }) + "\n",
    );
    return;
  }
  env.errOut(`demake: ${message}\n`);
  if (hint) env.errOut(`  hint: ${hint}\n`);
}

function mapDemakeExit(code: string): ExitCode {
  switch (code) {
    case "E_BAD_INPUT":
    case "E_UNSUPPORTED_FORMAT":
      return EXIT.BAD_INPUT;
    case "E_UNKNOWN_CONSOLE":
    case "E_INVALID_OPTION":
    case "E_INVALID_SIZE":
    case "E_SIZE_TOO_LARGE":
    case "E_INVALID_PALETTE":
      return EXIT.USAGE;
    case "E_TILE_BUDGET_EXCEEDED":
    case "E_STRICT_NONCOMPLIANT":
      return EXIT.FAILURE;
    default:
      return EXIT.INTERNAL;
  }
}
