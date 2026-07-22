/**
 * Stable process exit codes (doc 05 §Exit codes).
 *
 * `0`/`1`/`2` are the everyday trio; the `64`–`78` range mirrors BSD
 * `sysexits.h` so scripts and agents can branch on precise failure classes.
 * These values are a tested contract — never renumber them.
 */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** A conversion ran but failed. */
  FAILURE: 1,
  /** Wrong flags / bad command line. */
  USAGE: 2,
  /** Input data was malformed (EX_DATAERR). */
  BAD_INPUT: 65,
  /** A required input was missing (EX_NOINPUT). */
  NO_INPUT: 66,
  /** A requested feature is not available yet (EX_UNAVAILABLE). */
  UNAVAILABLE: 69,
  /** An internal invariant broke (EX_SOFTWARE). */
  INTERNAL: 70,
  /** The output could not be created (EX_CANTCREAT). */
  CANNOT_CREATE: 73,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
