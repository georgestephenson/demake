/**
 * The seam inside a tick, and the two things that make it one.
 *
 * A step boundary is the only place inside a tick where nothing is live: the
 * steps hand work to each other through the entity records and the contact
 * bitfield and never through a register, because the interpreter they are
 * written against has no registers. That is what lets a console whose bank is
 * smaller than a scene cut a tick into pieces (doc 13 §Banked cartridges) — and
 * it is a property of `emitTickSteps` rather than of any backend, which is why
 * this file is not one console's.
 *
 * Two things are checked and neither is checkable from a trace. That the
 * boundaries are **there and in doc 14's order**, because a backend that stopped
 * calling one would lose the seam silently and a reordered pair is the one bug
 * the tick's order exists to make impossible. And that each step is **smaller
 * than the window the smallest planned bank offers**, because that is the claim
 * the whole plan rests on: if a step ever grew past sixteen kilobytes, cutting a
 * tick at its steps would stop being enough and the granularity would have to go
 * lower again.
 *
 * The example library's own steps are comfortably small — `quest`, which is the
 * game that needs the banking, is the interesting one and cannot be built on this
 * console yet, so its measurements live in doc 13 rather than here. What this
 * guards is that nothing *else* drifts up to the limit first.
 */

import { describe, expect, it } from "vitest";

import { GB_BANK_SIZE } from "@demake/core";

import { buildGbRom } from "../src/codegen/gb.js";
import { stepLabel } from "../src/codegen/emit.js";
import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";

import { exampleProject } from "./_projects.js";

/**
 * The steps a scene with a level runs, in doc 14 §Runtime model's order.
 *
 * Written out rather than imported from the union, because the *order* is what
 * is under test and a list taken from the thing it checks would agree with
 * itself whatever it said.
 */
const ORDER = [
  "controls",
  "levelRules",
  "integrate",
  "collisions",
  "tileRules",
  "edgeRules",
  "camera",
] as const;

async function build(project: string) {
  const { source, files, levels, assets } = exampleProject(project);
  const program = compile(source, { profile: getProfile("gb"), files, levels });
  return buildGbRom(program, { title: project.toUpperCase(), assets });
}

describe("a tick's steps", () => {
  it("names every step of every scene, in the order the interpreter runs them", async () => {
    // The caves are the smallest example with a level in every scene, which is
    // what makes the full seven-step order observable rather than the six a
    // scene without one runs.
    const built = await build("caves");
    for (let scene = 0; scene < built.stats.scenes; scene += 1) {
      const at = ORDER.map((step) => built.symbols.get(stepLabel(scene, step)));
      const present = at.filter((address) => address !== undefined) as number[];
      // A scene with no level runs six of the seven; every other step is there.
      expect(present.length, `scene ${scene}`).toBeGreaterThanOrEqual(ORDER.length - 1);
      // Ascending, which is the tick's order read back off the cartridge.
      for (let index = 1; index < present.length; index += 1) {
        expect(present[index] as number, `scene ${scene}`).toBeGreaterThanOrEqual(
          present[index - 1] as number,
        );
      }
      // And they are inside their own scene's tick, not somebody else's.
      const tick = built.symbols.get(`SceneTick_${scene}`) as number;
      const reset = built.symbols.get(`SceneReset_${scene}`) as number;
      for (const address of present) {
        expect(address, `scene ${scene}`).toBeGreaterThanOrEqual(tick);
        expect(address, `scene ${scene}`).toBeLessThan(reset);
      }
    }
  }, 60_000);

  it("keeps every step under a bank window, which is what the plan rests on", async () => {
    for (const project of ["caves", "shooter", "runner"]) {
      const built = await build(project);
      const marks = [...built.symbols]
        .filter(([name]) => name.startsWith("Step_"))
        .sort((a, b) => a[1] - b[1]);
      expect(marks.length).toBeGreaterThan(0);
      for (const [index, [name, address]] of marks.entries()) {
        // The next mark, or the end of the last scene's tick — which is the
        // reset routine that follows it.
        const scene = Number(name.split("_")[1]);
        const end = marks[index + 1]?.[1] ?? (built.symbols.get(`SceneReset_${scene}`) as number);
        expect(end - address, `${project} ${name}`).toBeLessThan(GB_BANK_SIZE);
      }
    }
  }, 120_000);
});
