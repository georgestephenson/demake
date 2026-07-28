#!/usr/bin/env node
/**
 * Web bundle budget (doc 07 §Quality bar).
 *
 * Lighthouse covers the rendered-page metrics; this covers the one number a
 * pull request can regress silently — how much JavaScript the site is. It sums
 * *every* script in the built `dist/`, gzipped: the entry chunk, all five lazy
 * sections, and both engine workers. That is deliberately stricter than what any
 * one visitor downloads (the entry chunk plus the section they opened, which is
 * around 210 KB at its worst), because a sum cannot be satisfied by moving code
 * between chunks — only by there being less of it.
 *
 * Usage: node tools/ci/check-web-budget.mjs [dist-dir]
 */

import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "packages/web/dist";
/**
 * The ceiling, in gzipped kilobytes, over the whole site's JavaScript.
 *
 * It is close, and it moved once. The NES cost 4.6 KB gzipped end to end — a
 * second instruction set, a second emulator and a second set of hardware tables,
 * all of it in the bundle because doc 07 forbids fetching a core — its sound
 * driver a further 1.5 KB, a Sega vertical 21 KB, and a Z80 audio driver after
 * that. By the end of all of it the site sat 36 bytes under 300 KB, which is not
 * headroom so much as a coincidence.
 *
 * Running the tournaments in parallel (doc 04 §Running the tournament) then cost
 * 3.3 KB: the executor seam and the content-keyed prologue cache that stops a
 * fan-out decoding its source once per candidate, both in `@demake/core` and so
 * in every chunk that carries the engine — the CLI pays for them too. The page's
 * own share is nil, because a lane is another instance of `core.worker.ts` rather
 * than a new kind of worker; the alternative was measured at 41 KB.
 *
 * It moved a second time for the Mega Drive, and the measurement is worth
 * recording because it is what a console costs end to end: **23.8 KB gzipped**,
 * of which 18.6 KB is the codegen backend and the 68000 encoder in
 * `core.worker.ts` and 5.2 KB is a fourth emulator in the game section. Splitting
 * was considered and does not apply — the sum is a sum precisely so that moving
 * code between chunks cannot satisfy it — and there is no fat to take out of a
 * backend whose value layer is already a quarter the size of the Sega's. What a
 * visitor actually downloads is unchanged in shape: the entry chunk plus the one
 * section they opened.
 *
 * The rule has not changed. The next thing that does not fit should still be made
 * smaller first, and a *fifth* console is the point at which "one more backend"
 * stops being an acceptable answer — the way out then is to stop shipping every
 * console's emitter to every visitor, which means splitting `core.worker.ts` by
 * family and letting the budget become per-visitor rather than per-site.
 */
const BUDGET_KB = 335;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

let files;
try {
  files = walk(DIST);
} catch {
  console.error(`web budget: no build at ${DIST} — run \`pnpm build:web\` first.`);
  process.exit(1);
}

const scripts = files.filter((f) => f.endsWith(".js"));
if (scripts.length === 0) {
  console.error(`web budget: no JavaScript found in ${DIST} — is this a real build?`);
  process.exit(1);
}

let total = 0;
const rows = [];
for (const file of scripts) {
  const gz = gzipSync(readFileSync(file), { level: 9 }).length;
  total += gz;
  rows.push([file.slice(DIST.length + 1), gz]);
}

rows.sort((a, b) => b[1] - a[1]);
for (const [name, gz] of rows) {
  console.log(`  ${(gz / 1024).toFixed(1).padStart(7)} KB gz  ${name}`);
}
const totalKb = total / 1024;
console.log(`  ${totalKb.toFixed(1).padStart(7)} KB gz  TOTAL (budget ${BUDGET_KB} KB)`);

if (totalKb > BUDGET_KB) {
  console.error(
    `\nweb budget exceeded: ${totalKb.toFixed(1)} KB gzipped > ${BUDGET_KB} KB (doc 07 §Quality bar).`,
  );
  process.exit(1);
}
