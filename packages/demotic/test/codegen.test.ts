/**
 * The backend's contract, as opposed to its behaviour.
 *
 * Behaviour is `rom.test.ts`'s job — it diffs a running cartridge against the
 * reference interpreter. What is checked here is the machinery that makes the
 * backend worth having: that the assembler encodes what it claims, that a
 * feature nothing uses leaves no trace in the ROM, and that a game gets exactly
 * the RAM its own objects need.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Asm, AsmError, label } from "../src/codegen/asm.js";
import { analyze } from "../src/codegen/analyze.js";
import { planLayout, ENTITY_SIZE } from "../src/codegen/layout.js";
import { buildGbRom } from "../src/codegen/gb.js";
import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");
const build = (source: string) => compile(source, { profile: getProfile("gb") });

describe("the SM83 assembler", () => {
  it("encodes the addressing forms the backend relies on", () => {
    const asm = new Asm(0);
    asm.ld("b", "a"); // 0x47
    asm.ldn("a", 0x12); // 0x3E 0x12
    asm.lda(0xc123); // 0xFA 0x23 0xC1
    asm.sta(0xc123); // 0xEA 0x23 0xC1
    asm.alu("adc", "hlp"); // 0x8E
    asm.aluN("cp", 4); // 0xFE 0x04
    asm.shift("sra", "hlp"); // 0xCB 0x2E
    asm.bit(7, "a"); // 0xCB 0x7F
    expect([...asm.assemble()]).toEqual([
      0x47, 0x3e, 0x12, 0xfa, 0x23, 0xc1, 0xea, 0x23, 0xc1, 0x8e, 0xfe, 0x04, 0xcb, 0x2e, 0xcb,
      0x7f,
    ]);
  });

  it("resolves forward references, relative and absolute", () => {
    const asm = new Asm(0x100);
    asm.jr("ahead");
    asm.nop();
    asm.label("ahead");
    asm.jp("ahead");
    asm.dw(label("ahead", 3));
    const bytes = asm.assemble();
    // jr skips the nop: the operand is relative to the instruction after it.
    expect(bytes[1]).toBe(1);
    expect([bytes[4], bytes[5]]).toEqual([0x03, 0x01]);
    expect([bytes[6], bytes[7]]).toEqual([0x06, 0x01]);
  });

  it("refuses a relative branch it cannot encode", () => {
    const asm = new Asm(0);
    asm.jr("far");
    asm.ds(200);
    asm.label("far");
    expect(() => asm.assemble()).toThrow(AsmError);
  });
});

describe("what a program needs", () => {
  it("leaves out the helpers a game never reaches", () => {
    // Two objects and one rule that only adds: no multiply, no divide, no
    // generator. A fixed engine would ship all three.
    const still = build(
      ["start play", "scene play", "create object mark (x 1, y 1, sprite m.png)"].join("\n"),
    );
    expect(buildGbRom(still).stats.helpers).toEqual([]);

    // Pong divides (the opponent's proportional steering), multiplies
    // (direction by speed) and draws (the opponent's wandering aim), so exactly
    // those three arrive.
    const pong = buildGbRom(build(read("pong.dmt"))).stats;
    expect(pong.helpers).toContain("Div32");
    expect(pong.helpers).toContain("Mul32");
    expect(pong.helpers).toContain("RngPick");

    // Breakout does the same arithmetic and never draws, so it ships no
    // generator at all — which is the half of this that is easy to get wrong.
    const breakout = buildGbRom(build(read(join("games", "breakout.dmt")))).stats;
    expect(breakout.helpers).toContain("Div32");
    expect(breakout.helpers).not.toContain("RngPick");
  });

  it("allocates work RAM per object, not per worst case", () => {
    const program = build(read("pong.dmt"));
    const analysis = analyze(program);
    const layout = planLayout(program, analysis);
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
    expect(planLayout(plain, analyze(plain)).rng).toBeNull();
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

  it("compiles a whole game into a fraction of the cartridge", () => {
    const { stats } = buildGbRom(build(read("pong.dmt")));
    expect(stats.bytes).toBeGreaterThan(1024);
    expect(stats.free).toBeGreaterThan(0x4000);
  });
});
