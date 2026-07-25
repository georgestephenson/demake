import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { profiles, getProfile } from "../src/profiles.js";
import { parseTests } from "../src/testing/parse.js";
import { runTests } from "../src/testing/run.js";

const dir = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const PONG = readFileSync(dir("pong.dmt"), "utf8");
const PONG_TESTS = readFileSync(dir("pong.test.dmt"), "utf8");

describe(".test.dmt", () => {
  it("parses the Pong suite cleanly", () => {
    const file = parseTests(PONG_TESTS);
    expect(file.diagnostics).toEqual([]);
    expect(file.cases.length).toBeGreaterThanOrEqual(6);
  });

  it("passes on every supported console", () => {
    // The headline property: one set of assertions, written once in relative
    // terms, checked against every playfield the game will ship on.
    const file = parseTests(PONG_TESTS);
    for (const profile of profiles) {
      const result = runTests(file, compile(PONG, { profile }));
      const failures = result.cases.filter((c) => !c.passed);
      expect(
        failures.map((c) => c.name),
        profile.id,
      ).toEqual([]);
    }
  });

  it("reports both sides of a failed comparison, in cells", () => {
    const file = parseTests(
      ["test the ball starts low", "press a", "expect ball1.y > 99"].join("\n"),
    );
    const result = runTests(file, compile(PONG, { profile: getProfile("gb") }));
    const assertion = result.cases[0]?.assertions[0];
    expect(assertion?.passed).toBe(false);
    // "9.0000 > 99.0000" — the actual value is the whole point of the message.
    expect(assertion?.detail).toMatch(/^\d+\.\d+ > \d+\.\d+$/);
  });

  it("fails an assertion that names something that does not exist", () => {
    const file = parseTests(["test nonsense", "expect ghost.x = 0"].join("\n"));
    const result = runTests(file, compile(PONG, { profile: getProfile("gb") }));
    expect(result.cases[0]?.passed).toBe(false);
    expect(result.cases[0]?.assertions[0]?.detail).toContain("no object named 'ghost'");
  });

  it("recovers per line, and rejects statements outside a case", () => {
    const file = parseTests(
      ["expect 1 = 1", "test a case", "wibble", "play 10 ticks", "expect scene title"].join("\n"),
    );
    expect(file.diagnostics.map((d) => d.code)).toEqual(["E_TEST_ORPHAN", "E_UNKNOWN_STATEMENT"]);
    expect(file.cases[0]?.steps).toHaveLength(2);
  });

  it("keeps cases isolated from one another", () => {
    const file = parseTests(
      ["test first", "press a", "play 200 ticks", "test second", "expect scene title"].join("\n"),
    );
    const result = runTests(file, compile(PONG, { profile: getProfile("gb") }));
    // The second case starts on the title screen despite the first leaving play.
    expect(result.cases[1]?.passed).toBe(true);
  });

  it("understands relative units in assertions", () => {
    const gb = runTests(
      parseTests(["test width", "expect screenwidth = 100vw"].join("\n")),
      compile(PONG, { profile: getProfile("gb") }),
    );
    const md = runTests(
      parseTests(["test width", "expect screenwidth = 100vw"].join("\n")),
      compile(PONG, { profile: getProfile("md") }),
    );
    expect(gb.passed).toBe(true);
    expect(md.passed).toBe(true);
  });
});
