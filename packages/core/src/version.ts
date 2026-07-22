/**
 * The engine version string.
 *
 * Phase 0 scaffold: a hand-maintained constant. Release tooling (Changesets,
 * doc 11) will become the source of truth for package versions; a later phase
 * wires this constant to that pipeline. It stays a literal — not a runtime read
 * of `package.json` — because `core` is platform-pure and must not touch `fs`.
 */
export const CORE_VERSION = "0.0.0";
