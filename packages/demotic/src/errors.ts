/**
 * Diagnostics.
 *
 * The language is deliberately flat and line-oriented: one statement per line,
 * no nesting, no block delimiters. That buys trivial error recovery — a bad
 * statement fails on its own line and every other statement still parses — so
 * a tool (or an agent) always gets the *full* list of problems in one pass
 * rather than the first one. Keep it that way.
 */

/** Severity of a diagnostic. `error` blocks compilation; `warning` does not. */
export type Severity = "error" | "warning";

/** One problem, anchored to a source line. */
export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. `E_UNKNOWN_PROP`. */
  code: string;
  message: string;
  /** 1-indexed source line. */
  line: number;
  /** Optional actionable next step. */
  hint?: string;
}

/** Thrown when compilation fails; carries every diagnostic, not just the first. */
export class GameLangError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    const errors = diagnostics.filter((d) => d.severity === "error");
    super(
      errors.length === 1 && errors[0]
        ? `line ${errors[0].line}: ${errors[0].message}`
        : `${errors.length} errors, first at line ${errors[0]?.line ?? 0}: ${errors[0]?.message ?? "unknown"}`,
    );
    this.name = "GameLangError";
    this.diagnostics = diagnostics;
  }
}

/** Render diagnostics as human-readable lines. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const hint = d.hint ? `\n    hint: ${d.hint}` : "";
      return `${d.severity} [${d.code}] line ${d.line}: ${d.message}${hint}`;
    })
    .join("\n");
}
