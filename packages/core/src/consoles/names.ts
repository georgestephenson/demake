/**
 * What a console was called, and where.
 *
 * Half the machines in the matrix were sold under two names — a Mega Drive is a
 * Genesis in America, a PC Engine is a TurboGrafx-16 — and a picker that offers
 * only one of them is a picker somebody cannot find their console in. So a spec
 * carries every name the hardware was sold under (`ConsoleSpec.otherNames`) and
 * this file is the one place that turns them into a label.
 *
 * The order is doc 03 §Names: British first, then Japanese, then American, then
 * anywhere else, and a region that kept the name before it is not repeated. The
 * separator is ` / ` because doc 03's own tier tables have written it that way
 * since the matrix existed. Both facts live here rather than at each call site,
 * for the reason `cli-spec` owns the flags and `lang/spec.ts` owns the keywords:
 * the second copy is the one that goes stale.
 */

import type { ConsoleSpec } from "./types.js";

/**
 * Every name a console was sold under, in region order and deduplicated.
 *
 * Deduplication is the spec's — a name a second region kept is simply not
 * listed there — so this is a concatenation rather than a filter, and a spec
 * that repeated one is caught by `test/consoles.test.ts` instead of being
 * quietly hidden here.
 */
export function consoleNames(spec: ConsoleSpec): readonly string[] {
  return spec.otherNames === undefined ? [spec.name] : [spec.name, ...spec.otherNames];
}

/**
 * The label a picker shows: every name the console was sold under, as one
 * string. A console with one name gets exactly that name, unchanged.
 */
export function consoleLabel(spec: ConsoleSpec): string {
  return consoleNames(spec).join(" / ");
}
