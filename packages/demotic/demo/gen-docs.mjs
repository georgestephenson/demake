#!/usr/bin/env node
/**
 * Write the generated Demotic reference into `packages/demotic/docs/`.
 *
 *   pnpm gen:demotic-docs
 *
 * A test compares the checked-in files against the generator, so this has to be
 * re-run whenever the language registry changes — the same arrangement the man
 * pages have with `cli-spec`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stdout } from "node:process";

const { referenceIndex, referencePages } = await import("../dist/index.js");

const out = fileURLToPath(new URL("../docs/", import.meta.url));
mkdirSync(out, { recursive: true });

const pages = referencePages();
for (const page of [...pages, referenceIndex(pages)]) {
  writeFileSync(`${out}${page.name}`, page.markdown);
  stdout.write(`wrote docs/${page.name}\n`);
}
