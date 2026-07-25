import { describe, expect, it } from "vitest";

import { check, compile } from "../src/compile.js";
import { streamLevel } from "../src/level/stream.js";
import { parseLevel } from "../src/level/parse.js";
import { getProfile, profiles } from "../src/profiles.js";
import { advance, DEFAULT_SEED, pick } from "../src/rng.js";
import { Sim } from "../src/sim.js";

const gb = getProfile("gb");

/** A chunk `width` wide and `height` tall, with `mark` down its second column. */
function chunk(width: number, height: number, mark: string): string {
  const rows = Array.from({ length: height }, () => {
    const row = Array(width).fill(" ");
    row[1] = mark;
    return row.join("");
  });
  return ["tile # pipe solid brick.svg", "tile o coin coin.svg", "map", ...rows].join("\n");
}

/** A game with a streamed course, big enough to compile on every console. */
function streamGame(statement: string): string {
  return [
    "start play",
    "scene play",
    statement,
    "create object bird (width 1 cell, height 1 cell, speed 20vw, sprite bird.svg)",
    "create bird bird1 in play (x 1, y 1)",
  ].join("\n");
}

const LEVELS = {
  "a.dmtl": chunk(6, 30, "#"),
  "b.dmtl": chunk(6, 30, "o"),
  "short.dmtl": chunk(6, 20, "#"),
  "clash.dmtl": ["tile # water", "map", ...Array(30).fill("  #   ")].join("\n"),
  // Tall streams stack along y, so each chunk has to be wide enough on its own.
  "big.dmtl": chunk(40, 30, "#"),
};

describe("stream", () => {
  it("lays chunks end to end, in the axis it was given", () => {
    const wide = compile(streamGame("stream c from a.dmtl, b.dmtl 24 wide"), {
      profile: gb,
      levels: LEVELS,
    });
    expect(wide.scenes[0]?.bounds).toEqual({ width: 144, height: 30 });

    const tall = compile(streamGame("stream c from big.dmtl 3 tall"), {
      profile: gb,
      levels: LEVELS,
    });
    expect(tall.scenes[0]?.bounds).toEqual({ width: 40, height: 90 });
  });

  /**
   * The headline property, and the reason composition happens at compile time:
   * the console decides how much of the course is visible and nothing else.
   */
  it("composes the same course on every console", () => {
    const source = streamGame("stream c from a.dmtl, b.dmtl 24 wide");
    const rows = profiles.map(
      (profile) => compile(source, { profile, levels: LEVELS }).scenes[0]?.level?.rows,
    );
    for (const grid of rows) expect(grid).toEqual(rows[0]);
  });

  it("gives a different course for a different seed, and the same one twice", () => {
    const course = (seed: string): readonly string[] | undefined =>
      compile([seed, streamGame("stream c from a.dmtl, b.dmtl 24 wide")].join("\n"), {
        profile: gb,
        levels: LEVELS,
      }).scenes[0]?.level?.rows;

    expect(course("seed 1")).toEqual(course("seed 1"));
    expect(course("seed 2")).not.toEqual(course("seed 1"));
  });

  it("rejects chunks that disagree on the dimension they are not laid along", () => {
    const { diagnostics } = check(streamGame("stream c from a.dmtl, short.dmtl 24 wide"), {
      profile: gb,
      levels: LEVELS,
    });
    expect(diagnostics.map((d) => d.code)).toContain("E_STREAM_MISMATCH");
  });

  it("rejects chunks that give one character two meanings", () => {
    const { diagnostics } = check(streamGame("stream c from a.dmtl, clash.dmtl 24 wide"), {
      profile: gb,
      levels: LEVELS,
    });
    expect(diagnostics.map((d) => d.code)).toContain("E_STREAM_LEGEND");
  });

  it("will not put two playfields in one scene", () => {
    const source = [
      "start play",
      "scene play",
      "stream c from a.dmtl 24 wide",
      "level d from a.dmtl",
      "create object bird (width 1 cell, height 1 cell, sprite bird.svg)",
      "create bird bird1 in play (x 1, y 1)",
    ].join("\n");
    const { diagnostics } = check(source, { profile: gb, levels: LEVELS });
    expect(diagnostics.map((d) => d.code)).toContain("E_DUPLICATE_LEVEL");
  });

  it("advances one generator across the whole program, so streams differ", () => {
    const source = [
      "start one",
      "scene one",
      "stream c1 from a.dmtl, b.dmtl 24 wide",
      "scene two",
      "stream c2 from a.dmtl, b.dmtl 24 wide",
      "create object bird (width 1 cell, height 1 cell, sprite bird.svg)",
      "create bird bird1 in one (x 1, y 1)",
      "create bird bird2 in two (x 1, y 1)",
    ].join("\n");
    const program = compile(source, { profile: gb, levels: LEVELS });
    expect(program.scenes[0]?.level?.rows).not.toEqual(program.scenes[1]?.level?.rows);
  });

  it("reports what the drawn chunks were made of, not an average of them", () => {
    // Direct check on the composition helper: 4 chunks of 6 is 24 cells, and
    // every column belongs to one chunk or the other, never a blend.
    const chunks = [
      { file: "a.dmtl", level: parseLevel(chunk(6, 4, "#")) },
      { file: "b.dmtl", level: parseLevel(chunk(6, 4, "o")) },
    ];
    const { level, diagnostics } = streamLevel(chunks, 4, "wide", 7, 1);
    expect(diagnostics).toEqual([]);
    expect(level.width).toBe(24);
    for (const row of level.rows) {
      for (const at of [1, 7, 13, 19]) expect(["#", "o"]).toContain(row[at]);
    }
  });
});

describe("seed", () => {
  it("defaults, and is carried on the program", () => {
    expect(
      compile(streamGame("stream c from a.dmtl 24 wide"), { profile: gb, levels: LEVELS }).seed,
    ).toBe(DEFAULT_SEED);
    const seeded = compile(["seed 4242", streamGame("stream c from a.dmtl 24 wide")].join("\n"), {
      profile: gb,
      levels: LEVELS,
    });
    expect(seeded.seed).toBe(4242);
  });

  it("allows only one", () => {
    const source = ["seed 1", "seed 2", "start p", "scene p"].join("\n");
    expect(check(source, { profile: gb }).diagnostics.map((d) => d.code)).toContain(
      "E_DUPLICATE_SEED",
    );
  });
});

describe("random", () => {
  const game = (seed: string): string =>
    [
      seed,
      "start play",
      "scene play",
      "create object dot (width 1 cell, height 1 cell, sprite dot.svg)",
      "create dot dot1 in play (x 1, y 1)",
      "when always in play then dot1.x as random(0, 9)",
    ].join("\n");

  function draws(source: string, ticks = 40): number[] {
    const sim = new Sim(compile(source, { profile: gb }));
    const out: number[] = [];
    for (let i = 0; i < ticks; i += 1) {
      sim.step({});
      out.push(Math.round((sim.entity("dot1")?.numbers["x"] ?? 0) / 65536));
    }
    return out;
  }

  it("draws whole numbers inside the range it was given", () => {
    for (const value of draws(game("seed 99"))) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(9);
    }
  });

  it("replays identically, and differs by seed", () => {
    expect(draws(game("seed 99"))).toEqual(draws(game("seed 99")));
    expect(draws(game("seed 100"))).not.toEqual(draws(game("seed 99")));
  });

  it("moves at all — a stuck generator would pass every other test here", () => {
    expect(new Set(draws(game("seed 99"))).size).toBeGreaterThan(1);
  });

  it("cannot set an initial value, which would be drawn once at build time", () => {
    const source = [
      "start play",
      "scene play",
      "create object dot (width 1 cell, height 1 cell, sprite dot.svg)",
      "create dot dot1 in play (x random(0, 5), y 1)",
    ].join("\n");
    expect(check(source, { profile: gb }).diagnostics.map((d) => d.code)).toContain(
      "E_NOT_CONSTANT",
    );
  });
});

describe("the generator itself", () => {
  it("stays in 32 unsigned bits", () => {
    let state = 0xdeadbeef;
    for (let i = 0; i < 1000; i += 1) {
      state = advance(state);
      expect(Number.isInteger(state)).toBe(true);
      expect(state).toBeGreaterThanOrEqual(0);
      expect(state).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("picks inside the range, and never divides by zero", () => {
    expect(pick(12345, 0)).toBe(0);
    expect(pick(12345, 1)).toBe(0);
    for (let state = 1; state < 5000; state += 137) {
      expect(pick(state, 7)).toBeGreaterThanOrEqual(0);
      expect(pick(state, 7)).toBeLessThan(7);
    }
  });
});
