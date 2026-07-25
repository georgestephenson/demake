import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { check } from "../src/compile.js";
import { profiles } from "../src/profiles.js";
import { parseTests } from "../src/testing/parse.js";
import { runTests } from "../src/testing/run.js";

/**
 * The example library, checked on every console.
 *
 * Pong alone was never going to be enough evidence: it uses two moving objects,
 * one collision shape and no removal. These five between them cover the features
 * a console runtime will actually have to implement, and the extremes it will
 * have to survive — which is why they exist before the runtime does.
 */
const GAMES = fileURLToPath(new URL("../fixtures/games/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

function read(dir: string, name: string): string {
  return readFileSync(`${dir}${name}`, "utf8");
}

/** Every `<name>.dmt` in the library that has a `<name>.test.dmt` beside it. */
const EXAMPLES = readdirSync(GAMES)
  .filter((f) => f.endsWith(".dmt") && !f.endsWith(".test.dmt"))
  .map((f) => f.replace(/\.dmt$/, ""));

describe("example games", () => {
  it("ships more than one, and each has a suite", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(4);
    const suites = readdirSync(GAMES).filter((f) => f.endsWith(".test.dmt"));
    expect(suites).toHaveLength(EXAMPLES.length);
  });

  it.each(EXAMPLES)("%s compiles for every console, without errors", (name) => {
    for (const profile of profiles) {
      const { program, diagnostics } = check(read(GAMES, `${name}.dmt`), { profile });
      const errors = diagnostics.filter((d) => d.severity === "error");
      expect(
        errors.map((d) => `${d.code} line ${d.line}: ${d.message}`),
        profile.id,
      ).toEqual([]);
      expect(program, profile.id).toBeDefined();
    }
  });

  it.each(EXAMPLES)("%s stays inside every console's sprite budget", (name) => {
    for (const profile of profiles) {
      const { program } = check(read(GAMES, `${name}.dmt`), { profile });
      expect(program?.budget.peakSprites, profile.id).toBeLessThanOrEqual(
        program?.budget.spriteLimit ?? 0,
      );
    }
  });

  it.each(EXAMPLES)("%s passes its own suite on every console", (name) => {
    const suite = parseTests(read(GAMES, `${name}.test.dmt`));
    expect(suite.diagnostics).toEqual([]);

    for (const profile of profiles) {
      const { program } = check(read(GAMES, `${name}.dmt`), { profile });
      const result = runTests(suite, program!);
      const failed = result.cases
        .filter((c) => !c.passed)
        .map(
          (c) =>
            `${c.name}: ${c.assertions
              .filter((a) => !a.passed)
              .map((a) => `${a.source} [${a.detail}]`)
              .join("; ")}`,
        );
      expect(failed, `${name} on ${profile.id}`).toEqual([]);
    }
  });

  it("keeps Pong passing too", () => {
    const suite = parseTests(read(FIXTURES, "pong.test.dmt"));
    for (const profile of profiles) {
      const { program } = check(read(FIXTURES, "pong.dmt"), { profile });
      expect(runTests(suite, program!).passed, profile.id).toBe(true);
    }
  });

  it("references only art that exists", () => {
    // Two asset roots, searched in order — `games/` first, then the shared
    // `fixtures/` where Pong's ball and paddle live and Breakout reuses them.
    // This is the lookup a Demakefile's repeatable `assets` directive specifies
    // (doc 15), modelled here so the examples exercise it before it is built.
    const present = new Set(
      [...readdirSync(GAMES), ...readdirSync(FIXTURES)].filter((f) => f.endsWith(".svg")),
    );
    for (const name of EXAMPLES) {
      const { program } = check(read(GAMES, `${name}.dmt`), { profile: profiles[0]! });
      for (const asset of program?.assets ?? []) {
        expect(present, `${name} → ${asset}`).toContain(asset);
      }
    }
  });
});
