/**
 * Man-page generator (doc 05 §Single source of truth item 3).
 *
 * Writes the roff man pages produced from `@demake/cli-spec` into
 * `packages/cli/man/`. Run via `pnpm --filter demake gen:man` after build; a CI
 * staleness check regenerates and fails on diff, so the checked-in pages can
 * never drift from the spec. Output is deterministic (no dates).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { allManPages } from "@demake/cli-spec";

function main(): void {
  const manDir = fileURLToPath(new URL("../man/", import.meta.url));
  mkdirSync(manDir, { recursive: true });
  for (const page of allManPages()) {
    writeFileSync(new URL(`../man/${page.filename}`, import.meta.url), page.content);
  }
  process.stdout.write(`wrote ${allManPages().length} man pages to ${manDir}\n`);
}

main();
