/**
 * Candidate-portfolio introspection (doc 09 `strategies()`, doc 05 `--strategy
 * list`).
 *
 * Exposes the named candidates for a console so an agent (or the `consoles
 * --json` / `prep --strategy list` surfaces) can enumerate them and pin one for
 * fast, reproducible re-runs.
 */

import { getConsole } from "./consoles/registry.js";
import { portfolioFor } from "./pipeline/portfolio.js";

/** A candidate strategy's public description. */
export interface StrategyInfo {
  id: string;
  scale: string;
  dither: string;
  description: string;
}

/** The candidate portfolio for a console (id or alias). */
export function strategies(consoleId: string): StrategyInfo[] {
  const spec = getConsole(consoleId);
  return portfolioFor(spec).map((c) => ({
    id: c.id,
    scale: c.scale,
    dither: c.dither.alg,
    description: c.description,
  }));
}
