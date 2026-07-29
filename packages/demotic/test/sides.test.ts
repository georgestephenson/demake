/**
 * `from above` — the side a collision was resolved on.
 *
 * A contact used not to say which side it happened on, and that one absence
 * shaped whole levels: footing taken from a landing surface was taken from its
 * *sides* too, so a solid slab of ground was a slab you could inch up and a pit
 * was something to hang on. This checks the narrowing does what it says, in the
 * interpreter that defines it.
 *
 * The side and the separation are one decision (`level/scene.ts` §contactOf), so
 * a rule that fires `from above` and the push that follows it cannot disagree —
 * which is the property these cases are really about.
 */

import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { Sim } from "../src/sim.js";
import { toNumber } from "../src/fixed.js";

/** A floor, a ceiling and a pillar, so all four sides are reachable. */
const LEVEL = [
  "tile # wall  solid w.svg",
  "tile = floor solid f.svg",
  "tile . air         a.svg",
  "",
  "map",
  ...Array.from({ length: 26 }, () => "#" + ".".repeat(38) + "#"),
  "#" + "=".repeat(38) + "#",
  "#".repeat(40),
].join("\n");

function run(rules: string, ticks: number, input: Record<string, boolean> = {}) {
  const source = [
    "start play",
    "scene play",
    "level room from room.dmtl",
    "camera follows p",
    "create object hero (width 1 cell, height 2 cells, speed 20, sprite h.svg)",
    "create hero p in play (x 4, y 20)",
    "create number above in play (value 0, visible 0)",
    "create number below in play (value 0, visible 0)",
    "create number sideways in play (value 0, visible 0)",
    "when always in play then p.ydirection as min(p.ydirection + 0.04, 0.9)",
    "control p left (xdirection -1) on hold",
    "control p right (xdirection 1) on hold",
    rules,
  ].join("\n");
  const program = compile(source, {
    profile: getProfile("gb"),
    levels: { "room.dmtl": LEVEL },
  });
  const sim = new Sim(program);
  for (let i = 0; i < ticks; i += 1) sim.step(input);
  const read = (name: string) => toNumber(sim.entity(name)?.numbers["value"] ?? 0);
  return { above: read("above"), below: read("below"), sideways: read("sideways") };
}

const COUNTERS = [
  "when hero touches floor, wall from above then above.value as above.value + 1",
  "when hero touches floor, wall from below then below.value as below.value + 1",
  "when hero touches floor, wall from left, right then sideways.value as sideways.value + 1",
].join("\n");

describe("collision sides", () => {
  it("calls landing on a floor `above` and nothing else", () => {
    const seen = run(COUNTERS, 200);
    expect(seen.above).toBeGreaterThan(0);
    expect(seen.below).toBe(0);
    expect(seen.sideways).toBe(0);
  });

  // The case the feature exists for: pressed into a wall while falling past it,
  // the contact resolves sideways — so a rule that grants footing `from above`
  // does not fire, and the hero keeps falling instead of hanging on the face.
  it("calls being pressed into a wall `left` or `right`, not `above`", () => {
    const seen = run(COUNTERS, 60, { left: true });
    expect(seen.sideways).toBeGreaterThan(0);
  });

  it("fires on any side when no side is named", () => {
    const any = run("when hero touches floor, wall then above.value as above.value + 1", 200);
    expect(any.above).toBeGreaterThan(0);
  });

  it("rejects a side that is not one of the four", () => {
    expect(() =>
      compile(
        [
          "start play",
          "scene play",
          "create object hero (width 1 cell, height 1 cell, sprite h.svg)",
          "create hero a in play (x 1, y 1)",
          "create hero b in play (x 4, y 1)",
          "when a hits b from sideways then a.visible as 0",
        ].join("\n"),
        { profile: getProfile("gb") },
      ),
    ).toThrow(/not a side/);
  });

  // A screen edge has one side, so a `from` on it says nothing and almost
  // certainly meant something else.
  it("rejects a side on a screen edge", () => {
    expect(() =>
      compile(
        [
          "start play",
          "scene play",
          "create object hero (width 1 cell, height 1 cell, sprite h.svg)",
          "create hero a in play (x 1, y 1)",
          "when a hits screenbottom from above then a.visible as 0",
        ].join("\n"),
        { profile: getProfile("gb") },
      ),
    ).toThrow(/only one side/);
  });

  it("rejects the same side twice", () => {
    expect(() =>
      compile(
        [
          "start play",
          "scene play",
          "create object hero (width 1 cell, height 1 cell, sprite h.svg)",
          "create hero a in play (x 1, y 1)",
          "create hero b in play (x 4, y 1)",
          "when a hits b from above, above then a.visible as 0",
        ].join("\n"),
        { profile: getProfile("gb") },
      ),
    ).toThrow(/twice/);
  });
});
