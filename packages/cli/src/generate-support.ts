/**
 * Console-support matrix generator (doc 03 §Support).
 *
 * Writes `docs/console-support.md` from the registries that actually decide the
 * answers, and splices the README's two support tables from the same source. Run
 * via `pnpm gen:console-docs` after build; a staleness test regenerates and fails
 * on diff, so neither can drift from the code — the same arrangement the man
 * pages have with `cli-spec`. Output is deterministic (no dates).
 *
 * **The README is spliced rather than written**, because unlike
 * `console-support.md` it is mostly prose somebody meant: only the two tables
 * are derived, and they sit between markers so the voice around them stays
 * hand-written. It went ten consoles stale before this existed, which is the
 * argument for generating it and also the argument for generating only the part
 * that is a fact.
 */

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readmeRegions, spliceRegions, supportMarkdown } from "./support.js";

function main(): void {
  const matrix = fileURLToPath(new URL("../../../docs/console-support.md", import.meta.url));
  writeFileSync(matrix, supportMarkdown());
  process.stdout.write(`wrote ${matrix}\n`);

  const readme = fileURLToPath(new URL("../../../README.md", import.meta.url));
  writeFileSync(readme, spliceRegions(readFileSync(readme, "utf8"), readmeRegions()));
  process.stdout.write(`wrote ${readme}\n`);
}

main();
