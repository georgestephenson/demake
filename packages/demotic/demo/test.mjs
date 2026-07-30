#!/usr/bin/env node
/**
 * Run a `.test.dmt` file against every console, or a named one.
 *
 * The headline is the last line: one set of assertions, written once, checked
 * against six different playfields. A game that passes on a Game Boy and fails
 * on a Mega Drive has a balance bug, and this is where it surfaces.
 *
 *   node packages/demotic/demo/test.mjs
 *   node packages/demotic/demo/test.mjs --console gb --verbose
 *
 * Requires `pnpm build` first — it imports the built `dist/`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argv, exit, stdout } from "node:process";

const { compile, formatDiagnostics, formatResults, getProfile, parseTests, profiles, runTests } =
  await import("../dist/index.js");
const { loadLevels, projectFiles } = await import("./levels.mjs");

const args = argv.slice(2);
const options = { console: null, verbose: false, game: null, tests: null };
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--console" || arg === "-c") options.console = args[(i += 1)];
  else if (arg === "--verbose" || arg === "-v") options.verbose = true;
  else if (arg.endsWith(".test.dmt")) options.tests = arg;
  else if (arg.endsWith(".dmt")) options.game = arg;
}

const gamePath =
  options.game ?? fileURLToPath(new URL("../fixtures/projects/pong/src/pong.dmt", import.meta.url));
const testPath =
  options.tests ??
  fileURLToPath(new URL("../fixtures/projects/pong/src/pong.test.dmt", import.meta.url));

const file = parseTests(readFileSync(testPath, "utf8"));
if (file.diagnostics.length > 0) {
  stdout.write(`${formatDiagnostics(file.diagnostics)}\n`);
  exit(2);
}

const source = readFileSync(gamePath, "utf8");
const levels = loadLevels(gamePath);
const files = projectFiles(gamePath);
const targets = options.console ? [getProfile(options.console)] : profiles;
const results = [];

for (const profile of targets) {
  let program;
  try {
    program = compile(source, { profile, files, levels });
  } catch (error) {
    stdout.write(`FAIL ${profile.id}: ${error.message}\n`);
    exit(1);
  }
  results.push(runTests(file, program));
}

stdout.write(`${formatResults(results, options.verbose)}\n`);

const cases = results.reduce((sum, r) => sum + r.cases.length, 0);
const failed = results.reduce((sum, r) => sum + r.cases.filter((c) => !c.passed).length, 0);
stdout.write(
  `\n${cases - failed}/${cases} cases passed across ${results.length} console${results.length === 1 ? "" : "s"}\n`,
);
exit(failed === 0 ? 0 : 1);
