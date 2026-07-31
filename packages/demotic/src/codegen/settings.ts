/**
 * The conversion settings a build carries (doc 15 §Resolution, doc 19 step 6).
 *
 * A Demakefile's `art`/`music`/`sound` blocks resolve to options per asset, and
 * this is how they reach the demakers: a map keyed by the asset's **resolved
 * path**, which is what `Program.assets` holds, so a backend never has to
 * re-resolve a reference to know which settings are which.
 *
 * It is optional everywhere. A build with no settings is exactly the build there
 * was before them, which is what keeps "delete the Demakefile and only the
 * artifacts change" true of this mechanism as well.
 */

import type { PrepOptions } from "@demake/core";

/**
 * Per-asset `prep` overrides, keyed by resolved path.
 *
 * Already validated by `demakefile/overrides.ts` — a backend receives typed
 * options and never a string, so there is one place that decides what a build
 * file may say and one place that reports a value it cannot read.
 */
export type ArtSettings = Readonly<Record<string, Partial<PrepOptions>>>;
