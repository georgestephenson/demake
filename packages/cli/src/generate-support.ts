/**
 * Console-support matrix generator (doc 03 §Support).
 *
 * Writes `docs/console-support.md` from the registries that actually decide the
 * answers. Run via `pnpm gen:console-docs` after build; a staleness test
 * regenerates and fails on diff, so the checked-in table can never drift from
 * the code — the same arrangement the man pages have with `cli-spec`. Output is
 * deterministic (no dates).
 */

import { writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { supportMarkdown } from "./support.js";

function main(): void {
  const path = fileURLToPath(new URL("../../../docs/console-support.md", import.meta.url));
  writeFileSync(path, supportMarkdown());
  process.stdout.write(`wrote ${path}\n`);
}

main();
