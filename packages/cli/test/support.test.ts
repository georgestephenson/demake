import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { consoles } from "@demake/core";
import { describe, expect, it } from "vitest";

import {
  EMULATOR_PROVEN,
  consoleSupport,
  describeAgainst,
  readmeRegions,
  spliceRegions,
  supportMarkdown,
  type ConsoleSupport,
} from "../src/support.js";
import { ROM_BUILDERS } from "../src/rom/registry.js";

/**
 * The E2E suite a console is proven in, as a stem.
 *
 * Almost every family took the console's own id. `emu.e2e.test.ts` is the
 * exception and now covers three: the Game Boy pair, named for the era when it
 * was the only suite there was, and the Mega Duck — which shares that file
 * because it shares the harness, the assembler and the battery, and differs only
 * in which emulator boots the result. One mapping rather than one per check,
 * because the two below have to agree in both directions to mean anything.
 */
const suiteStem = (id: string): string =>
  id === "dmg" || id === "gbc" || id === "megaduck" ? "emu" : id;

/**
 * The support matrix is generated, never hand-edited (doc 03 §Support). These are
 * the two staleness guards — one per generated file — plus the two cross-checks
 * that keep its one hand-kept column honest.
 *
 * The README's guard is the one that had to exist: that file is mostly prose and
 * only its two tables are derived, so nothing about it *looks* generated and it
 * drifted ten consoles before anybody noticed.
 */
describe("console support matrix", () => {
  it("docs/console-support.md matches the generator", () => {
    const path = fileURLToPath(new URL("../../../docs/console-support.md", import.meta.url));
    expect(readFileSync(path, "utf8")).toBe(supportMarkdown());
  });

  it("the README's generated regions match the generator", () => {
    const path = fileURLToPath(new URL("../../../README.md", import.meta.url));
    const text = readFileSync(path, "utf8");
    expect(spliceRegions(text, readmeRegions())).toBe(text);
  });

  it("splicing refuses a file with no region rather than appending one", () => {
    // The failure this guards against is a generator that wrote nothing and
    // said it had: the staleness check above would then pass for ever while the
    // table it exists to keep current sat frozen.
    expect(() => spliceRegions("# nothing here\n", readmeRegions())).toThrow(
      /no 'demaker-table' generated region/,
    );
  });

  /**
   * The README ladder's delta phrasing, over sets the real registries do not
   * currently produce.
   *
   * Two of its four answers are live today ("those N without X", "those N plus
   * X") and the other two are the safety net: the whole point of computing a
   * delta rather than writing one is that a console which broke the relationship
   * would turn the row into a list of names instead of a sentence that had
   * quietly become false. That branch is unreachable from the registries, so it
   * is reachable only from here.
   */
  it("phrases a capability against another as a delta, and lists names when it cannot", () => {
    const of = (...names: string[]): ConsoleSupport[] =>
      names.map((name) => ({ id: name, name }) as ConsoleSupport);
    const base = of("Game Boy", "NES", "Mega Drive");
    expect(describeAgainst(base, of("Game Boy", "NES", "Mega Drive"))).toBe("the same 3");
    expect(describeAgainst(base, of("Game Boy", "NES"))).toBe("those 3 without the Mega Drive");
    expect(describeAgainst(base, [...base, ...of("Lynx")])).toBe("those 3, plus the Lynx");
    // Both directions at once: no sentence is true, so it names the set.
    expect(describeAgainst(base, of("Game Boy", "NES", "Lynx"))).toBe("Game Boy, NES, Lynx");
  });

  it("every emulator-proven console has an E2E suite", () => {
    for (const id of Object.keys(EMULATOR_PROVEN)) {
      const suite = `${suiteStem(id)}.e2e.test.ts`;
      const path = fileURLToPath(new URL(`./${suite}`, import.meta.url));
      expect(existsSync(path), `${id} claims a pixel-perfect E2E but ${suite} is missing`).toBe(
        true,
      );
    }
  });

  it("every E2E suite is claimed by a console", () => {
    const dir = fileURLToPath(new URL("./", import.meta.url));
    const suites = readdirSync(dir).filter(
      // `rom.e2e.test.ts` builds cartridges rather than comparing framebuffers.
      (name) => name.endsWith(".e2e.test.ts") && name !== "rom.e2e.test.ts",
    );
    const claimed = new Set(Object.keys(EMULATOR_PROVEN).map(suiteStem));
    for (const suite of suites) {
      const stem = suite.replace(".e2e.test.ts", "");
      expect(claimed.has(stem), `${suite} runs but no console claims it in EMULATOR_PROVEN`).toBe(
        true,
      );
    }
  });

  it("only reports `rom` for a console whose family has a builder", () => {
    for (const row of consoleSupport()) {
      if (!row.formats.includes("rom")) continue;
      expect(ROM_BUILDERS[row.family], `${row.id} reports rom with no builder`).toBeDefined();
    }
  });

  it("covers every console in the registry", () => {
    expect(consoleSupport().map((row) => row.id)).toEqual(consoles().map((spec) => spec.id));
  });
});
