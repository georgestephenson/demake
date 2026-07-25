import { describe, expect, it } from "vitest";

import { check, compile } from "../src/compile.js";
import { boundsOf, follow, separateFromTile, tilesUnder } from "../src/level/scene.js";
import { parseLevel } from "../src/level/parse.js";
import { getProfile } from "../src/profiles.js";
import { Sim } from "../src/sim.js";
import { fromInt, toNumber } from "../src/fixed.js";

const gb = getProfile("gb");
const md = getProfile("md");

/**
 * A 60x30 room: solid floor along the bottom, a strip of spikes at columns
 * 30–33, and one coin. Bigger than every playfield in the set, so it scrolls
 * everywhere.
 */
const ROOM = (() => {
  const width = 60;
  const height = 30;
  const rows = Array.from({ length: height }, () => Array(width).fill(" "));
  for (let x = 0; x < width; x += 1) (rows[height - 2] as string[])[x] = "#";
  for (let x = 30; x < 34; x += 1) (rows[height - 2] as string[])[x] = "^";
  (rows[height - 3] as string[])[5] = "o";
  return [
    "tile # floor solid brick.svg",
    "tile ^ spikes spikes.svg",
    "tile o coin coin.svg",
    "map",
    ...rows.map((row) => row.join("")),
  ].join("\n");
})();

const LEVELS = { "room.dmtl": ROOM };

const GAME = [
  "start play",
  "scene play",
  "level room from room.dmtl",
  "camera follows hero1",
  "create object hero (width 1 cell, height 1 cell, speed 60vw, sprite hero.svg)",
  "create hero hero1 in play (x 2, y levelheight - 3)",
  "create number score in play (value 0, x 1, y 1)",
  "control hero1 right (xdirection 1) on hold",
  "control hero1 left (xdirection -1) on hold",
  "when always in play then hero1.ydirection as min(hero1.ydirection + 0.05, 0.9)",
  "when hero1 touches floor then ydirection as 0",
  "when hero1 touches spikes then scene as over",
  "when hero1 hits coin then score.value as score.value + 1",
  "when always in play then (score.x, score.y) as (camera.x + 1, camera.y + 1)",
  "scene over",
  'create text lost in over (x 1, y 1, text "lost")',
].join("\n");

function run(profile = gb, ticks = 60, input: Record<string, boolean> = {}): Sim {
  const sim = new Sim(compile(GAME, { profile, levels: LEVELS }));
  for (let i = 0; i < ticks; i += 1) sim.step(input);
  return sim;
}

const cells = (value: number | undefined): number => toNumber(value ?? 0);

describe("a scene with a level", () => {
  it("takes the level's size as its playfield, not the screen's", () => {
    for (const profile of [gb, md]) {
      const program = compile(GAME, { profile, levels: LEVELS });
      expect(program.scenes[0]?.bounds).toEqual({ width: 60, height: 30 });
      // A scene without a level is the screen, exactly as before.
      expect(program.scenes[1]?.bounds).toEqual({
        width: profile.screenWidth,
        height: profile.screenHeight,
      });
    }
  });

  it("stops an object at the level's edge, not a screen-width in", () => {
    const sim = run(gb, 900, { right: true });
    expect(cells(sim.entity("hero1")?.numbers["x"])).toBeGreaterThan(gb.screenWidth);
  });

  it("is too small for a console it does not cover", () => {
    const tiny = ["tile # floor solid brick.svg", "map", ...Array(10).fill("##########")].join(
      "\n",
    );
    const { diagnostics } = check(GAME, { profile: md, levels: { "room.dmtl": tiny } });
    expect(diagnostics.map((d) => d.code)).toContain("E_LEVEL_TOO_SMALL");
  });
});

describe("tiles as collision targets", () => {
  it("stops a falling object on a solid tile", () => {
    const sim = run(gb, 120);
    const hero = sim.entity("hero1");
    // Floor row is 28, so a one-cell hero rests with its top on row 27.
    expect(cells(hero?.numbers["y"])).toBeCloseTo(27, 1);
    expect(cells(hero?.numbers["ydirection"])).toBeLessThanOrEqual(0.05);
  });

  it("fires on a named tile that is not solid, and does not stop on it", () => {
    // Spikes are named but not solid: the hero runs into them and the scene
    // changes, which could not happen if it had been blocked first.
    const sim = run(gb, 900, { right: true });
    expect(sim.scene).toBe("over");
  });

  it("does not know about a tile no rule names", () => {
    // No rule mentions `coin` here, so nothing collides with it — the same rule
    // objects follow, where a pair only interacts because a rule said so.
    const quiet = GAME.replace("when hero1 hits coin then score.value as score.value + 1", "");
    const sim = new Sim(compile(quiet, { profile: gb, levels: LEVELS }));
    for (let i = 0; i < 200; i += 1) sim.step({ right: true });
    expect(cells(sim.entity("score")?.numbers["value"])).toBe(0);
  });

  it("rejects a tile name no level defines", () => {
    const source = GAME.replace("touches spikes", "touches lava");
    expect(check(source, { profile: gb, levels: LEVELS }).diagnostics.map((d) => d.code)).toContain(
      "E_UNKNOWN_ENTITY",
    );
  });
});

describe("the camera", () => {
  it("starts clamped inside the level", () => {
    const sim = run(gb, 2);
    expect(sim.camera.x).toBe(0);
    expect(toNumber(sim.camera.y)).toBe(30 - gb.screenHeight);
  });

  it("follows its target and never runs off the end", () => {
    // Stopping short of the spikes at column 30: the point here is the view,
    // and a dead hero resets the camera along with everything else.
    const sim = run(gb, 100, { right: true });
    expect(toNumber(sim.camera.x)).toBeGreaterThan(0);
    expect(toNumber(sim.camera.x)).toBeLessThanOrEqual(60 - gb.screenWidth);
  });

  it("does not move at all when the level is no bigger than the screen", () => {
    // The non-scrolling case needs no special handling: the clamp does it.
    // Same legend as the room — the names the rules use are declared by the
    // legend, whether or not the grid happens to use them.
    const flat = [
      "tile # floor solid brick.svg",
      "tile ^ spikes spikes.svg",
      "tile o coin coin.svg",
      "map",
      ...Array(28).fill("#".repeat(40)),
    ].join("\n");
    const sim = new Sim(compile(GAME, { profile: md, levels: { "room.dmtl": flat } }));
    for (let i = 0; i < 300; i += 1) sim.step({ right: true });
    expect(sim.camera).toEqual({ x: 0, y: 0 });
  });

  it("is readable, so a hud can be pinned to the view", () => {
    // Two still ticks at the end, because the camera moves after the rules run:
    // a rule reading `camera.x` sees where the view was when the tick began, so
    // a HUD trails by one tick while the world is moving and lands on the view
    // the moment it stops. Invisible in play, worth being explicit about here.
    const sim = run(gb, 100, { right: true });
    sim.step({});
    sim.step({});
    const score = sim.entity("score");
    expect(score?.numbers["x"]).toBe(sim.camera.x + fromInt(1));
    expect(score?.numbers["y"]).toBe(sim.camera.y + fromInt(1));
  });

  it("has no properties beyond x and y", () => {
    const source = GAME.replace("camera.x + 1", "camera.z + 1");
    expect(check(source, { profile: gb, levels: LEVELS }).diagnostics.map((d) => d.code)).toContain(
      "E_UNKNOWN_PROP",
    );
  });
});

describe("the scene helpers, directly", () => {
  const level = parseLevel(
    ["tile # wall solid brick.svg", "map", "####", "#  #", "#  #", "####"].join("\n"),
  );

  it("falls back to the screen when there is no level", () => {
    expect(boundsOf(undefined, gb)).toEqual({ width: 20, height: 18 });
  });

  it("treats an object's box as half-open, so resting is not overlapping", () => {
    // Sitting exactly on row 3's boundary: touching the wall, not inside it.
    expect(tilesUnder(level, fromInt(1), fromInt(2), fromInt(1), fromInt(1))).toEqual([]);
    expect(tilesUnder(level, fromInt(1), fromInt(2), fromInt(1), fromInt(2))).toHaveLength(1);
  });

  it("pushes out along the shallower axis", () => {
    const [hit] = tilesUnder(level, fromInt(1), fromInt(2), fromInt(1), fromInt(2));
    const moved = separateFromTile(hit!, fromInt(1), fromInt(2), fromInt(1), fromInt(2));
    // Barely into row 3 from above, so up is shallower than sideways.
    expect(moved.x).toBe(fromInt(1));
    expect(toNumber(moved.y)).toBe(1);
  });

  it("centres on its target and clamps at both ends", () => {
    const bounds = { width: 60, height: 30 };
    expect(follow(0, 0, bounds, gb)).toEqual({ x: 0, y: 0 });
    expect(follow(fromInt(59), fromInt(29), bounds, gb)).toEqual({
      x: fromInt(40),
      y: fromInt(12),
    });
    expect(follow(fromInt(30), fromInt(15), bounds, gb)).toEqual({ x: fromInt(20), y: fromInt(6) });
  });
});
