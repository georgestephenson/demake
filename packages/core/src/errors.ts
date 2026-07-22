/**
 * Typed errors (doc 09 §Design rules, doc 05 §Structured errors).
 *
 * Hardware-impossible requests and malformed inputs throw `DemakeError`, whose
 * `code` is a stable, enumerated identifier shared with the CLI's `--json`
 * error output. Quality degradations (tile merges, palette compromise) are
 * *not* errors — they surface as warnings/stats, or become errors only under
 * `strict`. Every error carries a `hint` with the likely fix so an agent can
 * self-correct without external docs.
 */

/** Enumerated, stable error codes (extended as the engine grows). */
export type DemakeErrorCode =
  | "E_UNSUPPORTED_FORMAT"
  | "E_BAD_INPUT"
  | "E_UNKNOWN_CONSOLE"
  | "E_SIZE_TOO_LARGE"
  | "E_INVALID_OPTION"
  | "E_INVALID_SIZE"
  | "E_INVALID_PALETTE"
  | "E_NO_VALID_CANDIDATE"
  | "E_TILE_BUDGET_EXCEEDED"
  | "E_STRICT_NONCOMPLIANT"
  | "E_UNSUPPORTED_FAMILY"
  | "E_UNSUPPORTED_OUTPUT"
  | "E_MANIFEST_MISMATCH"
  | "E_TOOLCHAIN_MISSING"
  | "E_INTERNAL";

/** A structured, agent-actionable error. */
export class DemakeError extends Error {
  readonly code: DemakeErrorCode;
  readonly hint: string | undefined;
  readonly docs: string | undefined;

  constructor(
    code: DemakeErrorCode,
    message: string,
    options: { hint?: string; docs?: string } = {},
  ) {
    super(message);
    this.name = "DemakeError";
    this.code = code;
    this.hint = options.hint;
    this.docs = options.docs;
  }

  /** The JSON shape emitted under `--json` on failure (doc 05). */
  toJSON(): { code: DemakeErrorCode; message: string; hint?: string; docs?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.docs !== undefined ? { docs: this.docs } : {}),
    };
  }
}
