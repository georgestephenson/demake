/**
 * Running a `.test.dmt` from the page (doc 19 §The suite editor).
 *
 * The interesting part is not that a passing suite passes — `runTests` is the
 * engine's and has its own tests one package down. It is what this layer adds:
 * running against *every* console at once, counting what could not be run, and
 * saying so in one line.
 *
 * That last one is here because it was wrong and nothing caught it. When no
 * console compiled, the summary and the caller's own suffix said the same thing
 * twice — "nothing ran, the game did not compile for any console — 13 consoles
 * the game does not compile for" — and it was found by looking at a screenshot.
 * A pure function that produces a sentence is a pure function that can be
 * checked.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { passed, runSuite, summarise } from "../src/lib/suite.js";

const PROJECTS = dirname(
  createRequire(import.meta.url).resolve("@demake/demotic/fixtures/projects/pong/src/pong.dmt"),
);
const read = (name: string): string => readFileSync(join(PROJECTS, "..", "..", name), "utf8");
const GAME = read("pong/src/pong.dmt");
const SUITE = read("pong/src/pong.test.dmt");
const FILES = ["src/pong.dmt", "src/pong.test.dmt"];

describe("running a suite", () => {
  it("runs every case on every console the game compiles for", () => {
    const run = runSuite(GAME, SUITE, { files: FILES, levels: {} });
    // Every console, which is the whole point: the same relative assertions on
    // a dozen playfields is what makes a suite a balance check.
    expect(run.results.length).toBeGreaterThan(5);
    expect(run.skipped).toBe(0);
    expect(run.failed).toBe(0);
    // Every case, once per console — which is what "runs on every console" means
    // and the number the summary reports.
    const inFile = SUITE.split("\n").filter((line) => line.startsWith("test ")).length;
    expect(inFile).toBeGreaterThan(5);
    expect(run.cases).toBe(inFile * run.results.length);
    expect(passed(run)).toBe(true);
    expect(summarise(run)).toMatch(/^\d+\/\d+ cases passed across \d+ consoles$/);
  });

  it("says nothing ran, once, when the game does not compile anywhere", () => {
    const run = runSuite("start nowhere\n", SUITE, { files: FILES, levels: {} });
    expect(run.results).toHaveLength(0);
    expect(run.cases).toBe(0);
    expect(run.skipped).toBeGreaterThan(5);
    // Not a pass. It reported one for a while, because nothing failed.
    expect(passed(run)).toBe(false);
    expect(summarise(run)).toBe("nothing ran: the game does not compile for any console");
    // And the count of skipped consoles is *not* also tacked on: it is the same
    // fact as "did not compile for any console", said twice.
    expect(summarise(run)).not.toMatch(/does not compile for$/);
  });

  it("reports a failing assertion rather than throwing", () => {
    const run = runSuite(GAME, "test a false claim\nexpect 1 = 2\n", {
      files: FILES,
      levels: {},
    });
    expect(run.failed).toBe(run.results.length);
    expect(passed(run)).toBe(false);
    expect(summarise(run)).toMatch(/^0\/\d+ cases passed/);
    expect(run.report).toContain("a false claim");
  });
});
