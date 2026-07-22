/**
 * A deterministic, platform-pure hello-world function.
 *
 * This is the Phase 0 stand-in for the real engine surface (doc 09). It exists
 * so the CLI and tests have a genuine `@demake/core` export to import and
 * exercise end to end, proving the workspace wiring — package resolution, the
 * project-references build, and the test harness — actually works.
 *
 * @param name - Who to greet. Defaults to "world".
 * @returns A stable greeting string (no randomness, no clock — see the
 *   determinism lint rule).
 */
export function greeting(name = "world"): string {
  return `demake core says hello, ${name}`;
}
