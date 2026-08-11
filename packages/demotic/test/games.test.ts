import { describe, expect, it } from "vitest";

import { arrangeScore, countWrites, parseMidi } from "@demake/audio";

import { check } from "../src/compile.js";
import { profiles } from "../src/profiles.js";
import { parseTests } from "../src/testing/parse.js";
import { runTests } from "../src/testing/run.js";
import { EXAMPLES, exampleProject, gameTests, projectBytes, projectFiles } from "./_projects.js";

/**
 * The example library, checked on every console.
 *
 * Pong alone was never going to be enough evidence: it uses two moving objects,
 * one collision shape and no removal. These between them cover the features a
 * console runtime will actually have to implement, and the extremes it will have
 * to survive — which is why they exist before the runtime does.
 *
 * Each is a *project* now (doc 19): a folder with its own `src/`, `art/`,
 * `music/`, `sound/` and, where it has one, `levels/`. So a game's assets are
 * found because they are its own, rather than because they happened to sit in a
 * directory it shared with six other games.
 */

/** Compile one example the way an edge would: its files, its levels, its own art. */
function checkGame(name: string, profile: (typeof profiles)[number]) {
  const { source, files, levels } = exampleProject(name);
  return check(source, { profile, files, levels });
}

describe("example games", () => {
  it("ships more than one, and each is a project with a suite", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(4);
    for (const name of EXAMPLES) {
      const files = projectFiles(name);
      expect(files, name).toContain(`src/${name}.dmt`);
      expect(files, name).toContain(`src/${name}.test.dmt`);
    }
  });

  it.each(EXAMPLES)("%s compiles for every console, without errors", (name) => {
    for (const profile of profiles) {
      const { program, diagnostics } = checkGame(name, profile);
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
      const { program } = checkGame(name, profile);
      expect(program?.budget.peakSprites, profile.id).toBeLessThanOrEqual(
        program?.budget.spriteLimit ?? 0,
      );
    }
  });

  it.each(EXAMPLES)("%s passes its own suite on every console", (name) => {
    const suite = parseTests(gameTests(name));
    expect(suite.diagnostics).toEqual([]);

    for (const profile of profiles) {
      const { program } = checkGame(name, profile);
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

  it("names only assets its own project contains", () => {
    // What this checks got stronger with the project layout. It used to search
    // two shared directories, so an asset "existing" meant *somebody's* — now a
    // reference resolves inside one folder or not at all, and a resolved path is
    // by construction a file in that project (doc 19 §The rule).
    for (const name of EXAMPLES) {
      const files = new Set(projectFiles(name));
      const { program } = checkGame(name, profiles[0]!);
      for (const asset of program?.assets ?? []) {
        expect(files, `${name} → ${asset}`).toContain(asset);
      }
      for (const track of program?.tracks ?? []) {
        expect(files, `${name} → ${track}`).toContain(track);
      }
      for (const sound of program?.sounds ?? []) {
        expect(files, `${name} → ${sound}`).toContain(sound);
      }
    }
  });

  it("is self-contained: every project carries everything it names", () => {
    // The price of the folder layout is that Pong and Breakout each own a copy
    // of `ball.svg` (doc 19 §The example library becomes example projects), and
    // this is the property that price buys. A project reaching into a sibling
    // directory is not a project — it is a fragment of this repository.
    for (const name of EXAMPLES) {
      const { program } = checkGame(name, profiles[0]!);
      const named = [
        ...(program?.assets ?? []),
        ...(program?.tracks ?? []),
        ...(program?.sounds ?? []),
      ];
      expect(named.length, name).toBeGreaterThan(0);
      for (const path of named) expect(path.includes(".."), `${name} → ${path}`).toBe(false);
    }
  });

  /**
   * The library still moves the modulation wheel (AGENTS.md §Writing music).
   *
   * `pong` is the project `_audio-battery.ts` builds for its register battery on
   * every console with a driver, so the wheel on `rally.mid`'s lead is what puts
   * a vibrato's writes under a tick-for-tick diff on eleven machines. That
   * coverage is a property of a *fixture*, so nothing in the suite would notice
   * it going away: a track regenerated without the controller produces a
   * perfectly good schedule with no vibrato in it, and every audio assertion
   * there is still passes. This is the assertion that would not.
   *
   * It checks the arrangement rather than the file, because a wheel on a part
   * the arranger drops buys nothing.
   */
  it("still plays a melody with vibrato, on a channel", () => {
    const bytes = projectBytes("pong", "music/rally.mid");
    const arranged = arrangeScore(parseMidi(bytes), { console: "gb" });
    const modulated = arranged.plan.assignments.filter((seat) =>
      seat.parts.some((part) => part.notes.some((note) => note.vibrato !== undefined)),
    );
    expect(modulated).toHaveLength(1);
    // And the schedule has to carry it: on a console with no LFO that is a
    // pitch write per tick, so a dry arrangement of the same notes is smaller.
    expect(countWrites(arranged.script)).toBeGreaterThan(1500);
  });
});
