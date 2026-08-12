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

import { describe, expect, it } from "vitest";

import { analyze } from "../src/codegen/analyze.js";
import {
  BOX_SIZE,
  GB_MEMORY,
  NES_MEMORY,
  planLayout,
  SNES_MEMORY,
  ENTITY_SIZE,
} from "../src/codegen/layout.js";
import { buildGbRom } from "../src/codegen/gb.js";
import { compile } from "../src/compile.js";
import { DP_FREE } from "../src/codegen/snes/ops.js";
import { getProfile } from "../src/profiles.js";
import { exampleProject, gameSource } from "./_projects.js";

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
    const pong = (await buildGbRom(build(gameSource("pong")))).stats;
    expect(pong.helpers).toContain("Div32");
    expect(pong.helpers).toContain("Mul32");
    expect(pong.helpers).toContain("RngPick");

    // Breakout does the same arithmetic and never draws, so it ships no
    // generator at all — which is the half of this that is easy to get wrong.
    const breakout = (await buildGbRom(build(gameSource("breakout")))).stats;
    expect(breakout.helpers).toContain("Div32");
    expect(breakout.helpers).not.toContain("RngPick");
  });

  it("allocates work RAM per object, not per worst case", () => {
    const program = build(gameSource("pong"));
    const analysis = analyze(program);
    const layout = planLayout(program, analysis, GB_MEMORY);
    expect(layout.entities.length).toBe(program.instances.length);
    // Records are contiguous, and each is only as long as its own property set.
    for (let id = 1; id < layout.entities.length; id += 1) {
      const gap = (layout.entities[id] as number) - (layout.entities[id - 1] as number);
      expect(gap).toBe(layout.entitySizes[id - 1] as number);
    }
    // The ball moves, so it pays for all nine; a caption cannot move, cannot be
    // hidden and holds no number, so it pays for its box and stops there. A
    // record that was always the worst case is what this is here to catch.
    const slot = (name: string): number =>
      layout.entitySizes[program.instances.findIndex((i) => i.name === name)] as number;
    expect(slot("ball1")).toBe(ENTITY_SIZE);
    expect(slot("you")).toBe(BOX_SIZE);
    expect(slot("score1")).toBeLessThan(ENTITY_SIZE);
    expect(layout.used).toBeLessThan(2048);
    // Pong draws for the opponent's aim, so it has a generator; it has no
    // camera, so it has no camera variables.
    expect(layout.rng).not.toBeNull();
    expect(layout.camera).toBeNull();

    // Breakout draws nothing, and pays for nothing.
    const plain = build(gameSource("breakout"));
    expect(planLayout(plain, analyze(plain), GB_MEMORY).rng).toBeNull();
  });

  it("knows which properties a rule can actually change", () => {
    const program = build(gameSource("pong"));
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
    const { stats } = await buildGbRom(build(gameSource("pong")));
    expect(stats.bytes).toBeGreaterThan(1024);
    expect(stats.free).toBeGreaterThan(0x4000);
  });

  /*
   * The one cheap region that is an optimisation rather than a capability.
   *
   * A 65816 addresses the direct page in two bytes where an absolute takes
   * three, and its index registers are sixteen bits wide — so `$nnnn,x` reaches
   * all of bank zero and nothing this backend allocates *has* to be down there.
   * Filling it should therefore cost a game a slightly larger program and not a
   * build error, which is what `fastSpills` says. On a 6502 the same overrun has
   * to stay fatal, because page zero is the only place a pointer can live.
   *
   * `quest` is the game that reaches it — 239 bytes of a 238-byte page — and it
   * is what this asserts against, because a program written to overrun would
   * only prove the mechanism and not that the mechanism was ever needed.
   */
  it("spills the Super Nintendo's direct page into the heap rather than refusing", () => {
    const quest = exampleProject("quest");
    const program = compile(quest.source, {
      profile: getProfile("snes"),
      files: quest.files,
      levels: quest.levels,
    });
    const layout = planLayout(program, analyze(program), SNES_MEMORY);
    // The page is full to the byte, and the byte that did not fit is up in the
    // heap. `interrupt` is that byte because it is the last thing planned, so a
    // request that spills is the last one asked for — which is also why it is
    // safe to name here rather than scanning for whichever one moved.
    expect(layout.fastUsed).toBe(0x0100 - DP_FREE);
    expect(layout.interrupt).toBeGreaterThanOrEqual(SNES_MEMORY.heapStart);
    // And the beginning of the page is still the page, because only a request
    // the region cannot hold moves.
    expect(layout.tick).toBeLessThan(0x0100);
  });

  it("keeps the Super Nintendo's map exactly what it was for a game that fits", () => {
    // Pong is nowhere near 238 bytes, so every address it plans has to be the
    // one it always had: a spill that changed a game that fits would re-baseline
    // every checked-in trace for nothing.
    const program = compile(gameSource("pong"), { profile: getProfile("snes") });
    const layout = planLayout(program, analyze(program), SNES_MEMORY);
    for (const address of [layout.tick, layout.contacts, layout.contactsPrev, layout.interrupt]) {
      expect(address).toBeLessThan(0x0100);
    }
  });

  /**
   * A 6502's page zero spills too, and what may not is decided per *request*.
   *
   * Both halves matter and they pull opposite ways. Almost nothing the allocator
   * places on this CPU is dereferenced — the contact bitfields are read with
   * `$nnnn,x`, a temporary goes through `clamp32`, which asks `inFastPage` and
   * takes the pointer path for anything else — so a game refused for wanting 274
   * bytes of a 237-byte page is a game refused for wanting cheap addresses it does
   * not need. But `($nn),y` really is this CPU's one indirect mode, so the tile
   * walk's cursor cannot fall through to the heap: that would assemble an
   * instruction reading the wrong two bytes rather than failing.
   *
   * `quest` is the game that reaches it, and its own numbers are the assertion:
   * 274 wanted of 237, and every entity in eight kilobytes of cartridge RAM
   * because the console's own two would not hold them either.
   */
  it("spills a 6502 page zero for everything but a pointer", () => {
    expect(NES_MEMORY.fastSpills).toBe(true);
    const quest = exampleProject("quest");
    const program = compile(quest.source, {
      profile: getProfile("nes"),
      files: quest.files,
      levels: quest.levels,
    });
    const layout = planLayout(program, analyze(program), NES_MEMORY);
    // It planned at all, which it could not before — and it took the board's RAM
    // to do it, which is what tells the backend to declare a mapper.
    expect(layout.spilled).toBe(true);
    // The tile walk's cursor is in the page it has to be in.
    expect(layout.tilePtr).toBeGreaterThanOrEqual(NES_MEMORY.fastStart as number);
    expect(layout.tilePtr).toBeLessThan(0x0100);
    // And the beginning of the page is still the page, because only a request the
    // region cannot hold moves.
    expect(layout.tick).toBeLessThan(0x0100);
  });

  it("refuses a pointer that will not fit the page rather than spilling it", () => {
    // The half no game in the library reaches, so it is reached here: a page with
    // room for the first few requests and nothing like enough for all of them
    // leaves the cursor with nowhere to go, and that has to be a build error with
    // page zero's name on it rather than a `($nn),y` against a heap address.
    const quest = exampleProject("quest");
    const program = compile(quest.source, {
      profile: getProfile("nes"),
      files: quest.files,
      levels: quest.levels,
    });
    const cramped = { ...NES_MEMORY, fastEnd: (NES_MEMORY.fastStart as number) + 16 };
    expect(() => planLayout(program, analyze(program), cramped)).toThrow(/page zero/);
  });
});
