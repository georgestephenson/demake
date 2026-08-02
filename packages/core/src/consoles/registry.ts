/**
 * The console registry (doc 09 `consoles()` / `getConsole()`).
 *
 * A flat list plus id/alias lookup. Adding a console is adding its spec file and
 * one entry here (doc 02 §Extensibility). Ordered by tier then id so
 * `consoles --json` and the docs table are stable.
 */

import { DemakeError } from "../errors.js";

import { dmg } from "./dmg.js";
import { gamecom } from "./gamecom.js";
import { gba } from "./gba.js";
import { gbc } from "./gbc.js";
import { gg } from "./gg.js";
import { md } from "./md.js";
import { megaduck } from "./megaduck.js";
import { nds } from "./nds.js";
import { neogeo } from "./neogeo.js";
import { nes } from "./nes.js";
import { ngp } from "./ngp.js";
import { ngpc } from "./ngpc.js";
import { pce } from "./pce.js";
import { pokemini } from "./pokemini.js";
import { sg1000 } from "./sg1000.js";
import { sms } from "./sms.js";
import { snes } from "./snes.js";
import { supervision } from "./supervision.js";
import { vb } from "./vb.js";
import { ws } from "./ws.js";
import { wsc } from "./wsc.js";
import type { ConsoleSpec } from "./types.js";

const ALL: readonly ConsoleSpec[] = [
  // Tier 1
  dmg,
  gbc,
  nes,
  snes,
  md,
  sms,
  gba,
  nds,
  // Tier 2
  pce,
  gg,
  neogeo,
  ws,
  wsc,
  ngp,
  ngpc,
  // Tier 3
  vb,
  pokemini,
  supervision,
  gamecom,
  megaduck,
  sg1000,
];

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

/**
 * The same console, seen through one of its selectable modes.
 *
 * A console's `layout` is the mode `prep` fits a still picture into and the mode
 * every display ROM and pixel-perfect E2E was built against; `modes` are the
 * others the hardware has. Rather than thread a mode index through every stage,
 * a caller that wants one asks for a spec whose `layout` *is* that mode — so the
 * fitter, the budget, the compliance oracle and the codegen backends all see an
 * ordinary spec and none of them has to know a choice was made.
 *
 * `undefined` is the primary layout, which is why nothing that does not ask
 * changes.
 */
export function withMode(spec: ConsoleSpec, mode: number | undefined): ConsoleSpec {
  if (mode === undefined) return spec;
  const layout = spec.modes?.[mode];
  if (layout === undefined) {
    throw new DemakeError("E_INVALID_OPTION", `${spec.name} has no selectable layout ${mode}`, {
      hint: `this console declares ${spec.modes?.length ?? 0} selectable modes.`,
    });
  }
  return { ...spec, layout };
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
