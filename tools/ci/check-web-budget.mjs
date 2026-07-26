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
 * It is close, and deliberately not moved: the NES cost 4.6 KB gzipped end to
 * end — a second instruction set, a second emulator and a second set of hardware
 * tables, all of it in the bundle because doc 07 forbids fetching a core — and
 * its sound driver a further 1.5 KB. The site sits at 298 KB with both in it, so
 * there is under two kilobytes of room left. The next thing that does not fit
 * should be made smaller rather than given more room.
 */
const BUDGET_KB = 300;

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
