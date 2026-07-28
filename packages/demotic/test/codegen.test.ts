/**
 * The backend's contract, as opposed to its behaviour.
 *
 * Behaviour is `rom.test.ts`'s job — it diffs a running cartridge against the
 * reference interpreter. What is checked here is the machinery that makes the
 * backend worth having: that a feature nothing uses leaves no trace in the ROM,
 * and that a game gets exactly the RAM its own objects need. The assembler
 * underneath it is `core`'s, and so is its suite
 * (`packages/core/test/sm83.test.ts`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/codegen/analyze.js";
import { GB_MEMORY, planLayout, ENTITY_SIZE } from "../src/codegen/layout.js";
import { buildGbRom } from "../src/codegen/gb.js";
import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");
const build = (source: string) => compile(source, { profile: getProfile("gb") });

describe("what a program needs", async () => {
  it("leaves out the helpers a game never reaches", async () => {
    // Two objects and one rule that only adds: no multiply, no divide, no
    // generator. A fixed engine would ship all three.
    const still = build(
      ["start play", "scene play", "create object mark (x 1, y 1, sprite m.png)"].join("\n"),
    );
    expect((await buildGbRom(still)).stats.helpers).toEqual([]);

    // Pong divides (the opponent's proportional steering), multiplies
    // (direction by speed) and draws (the opponent's wandering aim), so exactly
    // those three arrive.
    const pong = (await buildGbRom(build(read("pong.dmt")))).stats;
    expect(pong.helpers).toContain("Div32");
    expect(pong.helpers).toContain("Mul32");
    expect(pong.helpers).toContain("RngPick");

    // Breakout does the same arithmetic and never draws, so it ships no
    // generator at all — which is the half of this that is easy to get wrong.
    const breakout = (await buildGbRom(build(read(join("games", "breakout.dmt"))))).stats;
    expect(breakout.helpers).toContain("Div32");
    expect(breakout.helpers).not.toContain("RngPick");
  });

  it("allocates work RAM per object, not per worst case", () => {
    const program = build(read("pong.dmt"));
    const analysis = analyze(program);
    const layout = planLayout(program, analysis, GB_MEMORY);
    expect(layout.entities.length).toBe(program.instances.length);
    // Records are contiguous and sized by the property set, nothing more.
    expect((layout.entities[1] as number) - (layout.entities[0] as number)).toBe(ENTITY_SIZE);
    expect(layout.used).toBeLessThan(2048);
    // Pong draws for the opponent's aim, so it has a generator; it has no
    // camera, so it has no camera variables.
    expect(layout.rng).not.toBeNull();
    expect(layout.camera).toBeNull();

    // Breakout draws nothing, and pays for nothing.
    const plain = build(read(join("games", "breakout.dmt")));
    expect(planLayout(plain, analyze(plain), GB_MEMORY).rng).toBeNull();
  });

  it("knows which properties a rule can actually change", () => {
    const program = build(read("pong.dmt"));
    const analysis = analyze(program);
    const ball = program.instances.find((instance) => instance.name === "ball1");
    const score = program.instances.find((instance) => instance.name === "score1");
    // The ball's direction is flipped by the bounce rules; its width is not
    // written anywhere, so the compiler can treat it as fixed.
    expect(analysis.writes.get(ball?.id ?? -1)?.has("xdirection")).toBe(true);
    expect(analysis.writes.get(ball?.id ?? -1)?.has("width")).toBe(false);
    expect(analysis.writes.get(score?.id ?? -1)?.has("value")).toBe(true);
  });

  it("compiles a whole game into a fraction of the cartridge", async () => {
    const { stats } = await buildGbRom(build(read("pong.dmt")));
    expect(stats.bytes).toBeGreaterThan(1024);
    expect(stats.free).toBeGreaterThan(0x4000);
  });
});
