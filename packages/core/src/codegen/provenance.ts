/**
 * Generated-source provenance (doc 06 §Output hygiene).
 *
 * Every artifact carries: tool name + version, the source hash, the full option
 * string, and a "regenerate with:" command line — and **never a timestamp**, so
 * output stays byte-deterministic. This module builds those lines once; each
 * backend wraps them in its language's comment syntax.
 */

import { crc32 } from "../image/png/checksums.js";
import { CORE_VERSION } from "../version.js";

import { hex8 } from "./text.js";

/** Inputs for a provenance header. */
export interface ProvenanceInput {
  consoleId: string;
  consoleName: string;
  format: string;
  /** The source image bytes, hashed for the header. */
  source: Uint8Array;
  /** A human label for the source (path/name), or `<stdin>`. */
  sourceName?: string;
  /** The full resolved option string, e.g. `--console gbc --format asm`. */
  options?: string;
  /** How the run reached a compliant image (exact path, manifest, or prep). */
  path: "compliant" | "manifest" | "prepped";
  /** The command that reproduces this artifact, if known (CLI passes it). */
  command?: string;
}

/** A stable content hash (CRC-32, lowercase hex) of the source bytes. */
export function sourceHash(bytes: Uint8Array): string {
  return hex8(crc32(bytes));
}

/** Build the provenance header lines (comment syntax added by the backend). */
export function buildHeader(input: ProvenanceInput): string[] {
  const lines = [
    `demake ${CORE_VERSION} - generated ${input.format} data; do not edit by hand.`,
    `console: ${input.consoleId} (${input.consoleName})`,
    `source: ${input.sourceName ?? "<image>"} (crc32 ${sourceHash(input.source)}, via ${input.path} path)`,
  ];
  if (input.options) lines.push(`options: ${input.options}`);
  if (input.command) lines.push(`regenerate with: ${input.command}`);
  return lines;
}
