#!/usr/bin/env node
/**
 * Web bundle budget (doc 07 §Quality bar: "< 300 KB JS gzipped before WASM
 * codecs").
 *
 * Lighthouse covers the rendered-page metrics; this covers the one number a
 * pull request can regress silently — the amount of JavaScript a visitor has to
 * download. It measures the built `dist/` the way a browser would: gzipped
 * bytes, counting the entry chunk and every chunk it pulls in, plus the engine
 * worker (which every conversion needs).
 *
 * Usage: node tools/ci/check-web-budget.mjs [dist-dir]
 */

import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "packages/web/dist";
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
