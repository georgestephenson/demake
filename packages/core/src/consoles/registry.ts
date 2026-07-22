/**
 * The console registry (doc 09 `consoles()` / `getConsole()`).
 *
 * A flat list plus id/alias lookup. Adding a console is adding its spec file and
 * one entry here (doc 02 §Extensibility). Ordered by tier then id so
 * `consoles --json` and the docs table are stable.
 */

import { DemakeError } from "../errors.js";

import { dmg } from "./dmg.js";
import { gbc } from "./gbc.js";
import type { ConsoleSpec } from "./types.js";

const ALL: readonly ConsoleSpec[] = [dmg, gbc];

const BY_KEY = (() => {
  const map = new Map<string, ConsoleSpec>();
  for (const spec of ALL) {
    map.set(spec.id, spec);
    for (const alias of spec.aliases) {
      map.set(alias, spec);
    }
  }
  return map;
})();

/** All console specs (data-only), sorted by tier then id. */
export function consoles(): ConsoleSpec[] {
  return [...ALL].sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));
}

/** Look up a console by id or alias, or `undefined` if unknown. */
export function findConsole(idOrAlias: string): ConsoleSpec | undefined {
  return BY_KEY.get(idOrAlias.toLowerCase());
}

/** Look up a console by id or alias, throwing a typed error if unknown. */
export function getConsole(idOrAlias: string): ConsoleSpec {
  const spec = findConsole(idOrAlias);
  if (!spec) {
    const known = consoles()
      .map((c) => c.id)
      .join(", ");
    throw new DemakeError("E_UNKNOWN_CONSOLE", `unknown console '${idOrAlias}'`, {
      hint: `known consoles: ${known}. Run 'demake consoles' to list them.`,
    });
  }
  return spec;
}
