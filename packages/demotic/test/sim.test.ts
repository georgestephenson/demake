import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { ONE, toNumber } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";
import { Sim, type InputState } from "../src/sim.js";

const gb = getProfile("gb");

const PONG = readFileSync(fileURLToPath(new URL("../fixtures/pong.dmt", import.meta.url)), "utf8");

/** Build a simulator from source, defaulting to the Game Boy profile. */
function sim(source: string, profile = gb): Sim {
  return new Sim(compile(source, { profile }));
}

/** Cell value of one property, as a plain number. */
function value(instance: Sim, name: string, prop: string): number {
  return toNumber(instance.entity(name)?.numbers[prop] ?? 0);
}

function steps(instance: Sim, count: number, input: InputState = {}): void {
  for (let i = 0; i < count; i += 1) instance.step(input);
}

describe("movement", () => {
  it("treats speed as cells per second, so a second of travel is one speed", () => {
    const world = sim(
      [
        "start play",
        "scene play",
        "create object ball (speed 8, sprite ball.png)",
        "create ball b in play (x 0, y 0, direction east)",
      ].join("\n"),
    );
    steps(world, 60);
    expect(value(world, "b", "x")).toBeCloseTo(8, 2);
  });

  it("covers the same ground per second on every console", () => {
    const source = [
      "start play",
      "scene play",
      "create object ball (speed 8, sprite ball.png)",
      "create ball b in play (x 0, y 0, direction east)",
    ].join("\n");

    const onGb = sim(source, gb);
    const onMd = sim(source, getProfile("md"));
    steps(onGb, 60);
    steps(onMd, 60);

    // Identical distance, on playfields that are 20 and 40 cells wide. What
    // differs is how much of the screen that crossing represents, which is the
    // documented trade of authoring in cells rather than in screen fractions.
    expect(value(onGb, "b", "x")).toBe(value(onMd, "b", "x"));
  });
});

describe("collisions", () => {
  const WALL = [
    "start play",
    "scene play",
    "create object ball (speed 60, sprite ball.png)",
    "create ball b in play (x 1, y 5, direction west)",
    "when ball hits screenleft then xdirection as flip",
  ].join("\n");

  it("flips direction and clamps the object back inside the playfield", () => {
    const world = sim(WALL);
    world.step();
    expect(value(world, "b", "x")).toBe(0);
    expect(world.entity("b")?.numbers["xdirection"]).toBe(ONE);

    world.step();
    expect(value(world, "b", "x")).toBe(1);
  });

  it("fires on contact, not on every tick of contact", () => {
    // A stationary object resting against a wall is one event. Without edge
    // triggering the flip would invert every tick and the object would buzz.
    const world = sim(
      [
        "start play",
        "scene play",
        "create object ball (speed 0, sprite ball.png)",
        "create ball b in play (x 0, y 5)",
        "create number fires in play (value 0, x 5, y 0)",
        "when ball hits screenleft then fires.value as (fires.value + 1)",
      ].join("\n"),
    );
    steps(world, 10);
    expect(value(world, "fires", "value")).toBe(1);
  });

  it("does not drag an object back to the wall a rule just moved it away from", () => {
    // Separation must be re-tested after the rule runs, or scoring — which
    // resets the ball to the middle — would immediately be undone.
    const world = sim(
      [
        "start play",
        "scene play",
        "create object ball (speed 60, sprite ball.png)",
        "create ball b in play (x 5, y 16, direction south)",
        "create number score in play (value 0, x 0, y 0)",
        "when ball hits screenbottom then (score.value, b.y, b.ydirection) as (score.value + 1, 1, -1)",
      ].join("\n"),
    );
    world.step();
    expect(value(world, "score", "value")).toBe(1);
    expect(value(world, "b", "y")).toBe(1);
    expect(world.entity("b")?.numbers["ydirection"]).toBe(-ONE);
  });

  it("computes a bounce angle from where the ball met the paddle", () => {
    const world = sim(
      [
        "start play",
        "scene play",
        "create object ball (width 1, height 1, speed 60, sprite ball.png)",
        "create object paddle (width 4, height 1, sprite paddle.png)",
        "create ball b in play (x 1, y 4, direction south)",
        "create paddle p in play (x 0, y 5)",
        "when ball hits paddle then (ydirection, xdirection) as (flip, (ball.centerx - paddle.centerx) / paddle.width)",
      ].join("\n"),
    );
    world.step();

    // Ball centre 1.5, paddle centre 2.0, paddle width 4 → -0.5/4 = -0.125.
    expect(world.entity("b")?.numbers["ydirection"]).toBe(-ONE);
    expect(toNumber(world.entity("b")?.numbers["xdirection"] ?? 0)).toBeCloseTo(-0.125, 4);
  });

  it("evaluates every value in a rule before any of them lands", () => {
    // If assignments applied one at a time, the second would read the first's
    // result and the two counters would disagree.
    const world = sim(
      [
        "start play",
        "scene play",
        "create object ball (speed 60, sprite ball.png)",
        "create ball b in play (x 1, y 5, direction west)",
        "create number a in play (value 5, x 0, y 0)",
        "create number c in play (value 9, x 3, y 0)",
        "when ball hits screenleft then (a.value, c.value) as (c.value, a.value)",
      ].join("\n"),
    );
    world.step();
    expect(value(world, "a", "value")).toBe(9);
    expect(value(world, "c", "value")).toBe(5);
  });
});

describe("controls", () => {
  const PADDLE = [
    "start play",
    "scene play",
    "create object p (speed 60, sprite p.png)",
    "create p p1 in play (x 5, y 5)",
    "control p1 left (xdirection -1) on hold",
    "control p1 right (xdirection 1) on hold",
  ].join("\n");

  it("restores the previous value when a held button comes up", () => {
    const world = sim(PADDLE);
    world.step({ left: true });
    expect(world.entity("p1")?.numbers["xdirection"]).toBe(-ONE);
    world.step({});
    expect(world.entity("p1")?.numbers["xdirection"]).toBe(0);
  });

  it("gives the last press priority, and unwinds in order on release", () => {
    const world = sim(PADDLE);
    world.step({ left: true });
    world.step({ left: true, right: true });
    expect(world.entity("p1")?.numbers["xdirection"]).toBe(ONE);

    world.step({ left: true });
    expect(world.entity("p1")?.numbers["xdirection"]).toBe(-ONE);

    world.step({});
    expect(world.entity("p1")?.numbers["xdirection"]).toBe(0);
  });

  it("fires `on press` once per press, not once per tick held", () => {
    const world = sim(
      [
        "start play",
        "scene play",
        "create object p (sprite p.png)",
        "create p p1 in play ()",
        "create number n in play (value 0, x 0, y 0)",
        "control p1 a (n.value n.value + 1) on press",
      ].join("\n"),
    );
    steps(world, 5, { a: true });
    expect(value(world, "n", "value")).toBe(1);
  });
});

describe("rules", () => {
  it("re-evaluates a level predicate every tick", () => {
    const world = sim(
      [
        "start play",
        "scene play",
        "create object p (speed 60, sprite p.png)",
        "create p chaser in play (x 0, y 0)",
        "create p target in play (x 10, y 0)",
        "when chaser.x < target.x in play then chaser.xdirection as 1",
        "when chaser.x > target.x in play then chaser.xdirection as -1",
      ].join("\n"),
    );
    steps(world, 30);
    // The two opposing rules settle the chaser on its target and hold it there.
    expect(Math.abs(value(world, "chaser", "x") - 10)).toBeLessThanOrEqual(1);
  });

  it("fires `reaches` once, on the transition", () => {
    const world = sim(
      [
        "start play",
        "scene play",
        "create object p (sprite p.png)",
        "create p p1 in play ()",
        "create number n in play (value 0, x 0, y 0)",
        "create number fires in play (value 0, x 4, y 0)",
        "when n.value reaches 3 then fires.value as (fires.value + 1)",
        "when a pressed then n.value as (n.value + 1)",
      ].join("\n"),
    );
    for (let i = 0; i < 6; i += 1) {
      world.step({ a: true });
      world.step({});
    }
    expect(value(world, "n", "value")).toBe(6);
    expect(value(world, "fires", "value")).toBe(1);
  });
});

describe("scenes", () => {
  const SCENES = [
    "start title",
    "scene title",
    "create text prompt in title (x 0, y 0, text hi)",
    "when a pressed in title then scene as play",
    "scene play",
    "create object p (speed 60, sprite p.png)",
    "create p p1 in play (x 5, y 5, direction east)",
    "when b pressed in play then scene as play",
  ].join("\n");

  it("switches scene at the end of the tick that asked for it", () => {
    const world = sim(SCENES);
    expect(world.scene).toBe("title");
    world.step({ a: true });
    expect(world.scene).toBe("play");
    expect(world.entities().map((e) => e.name)).toEqual(["p1"]);
  });

  it("resets a scene's objects to their declared values on entry", () => {
    const world = sim(SCENES);
    world.step({ a: true });
    steps(world, 60);
    expect(value(world, "p1", "x")).toBeGreaterThan(5);

    world.step({ b: true });
    expect(world.scene).toBe("play");
    expect(value(world, "p1", "x")).toBe(5);
  });
});

describe("hardware pressure", () => {
  it("notices when more sprites share a scanline than the console will draw", () => {
    const objects = Array.from({ length: 12 }, (_, i) => `create dot d${i} in play (x ${i}, y 4)`);
    const world = sim(
      ["start play", "scene play", "create object dot (sprite dot.png)", ...objects].join("\n"),
      getProfile("nes"),
    );
    world.step();

    const budget = world.runtimeBudget;
    expect(budget.peakSpritesPerLine).toBe(12);
    expect(budget.limit).toBe(8);
    expect(budget.exceeded).toBe(true);
  });

  it("stays quiet when the same row fits", () => {
    const objects = Array.from({ length: 12 }, (_, i) => `create dot d${i} in play (x ${i}, y 4)`);
    const world = sim(
      ["start play", "scene play", "create object dot (sprite dot.png)", ...objects].join("\n"),
      getProfile("md"),
    );
    world.step();
    expect(world.runtimeBudget.exceeded).toBe(false);
  });
});

describe("cross-console balance", () => {
  // The point of relative units: the same source must be the same *game* on a
  // 20x18 playfield and a 40x28 one, not merely the same rules.
  const CONSOLES = ["gb", "gg", "nes", "sms", "md", "snes"] as const;

  it("gives the ball the same crossing time on every console", () => {
    const times = CONSOLES.map((id) => {
      const profile = getProfile(id);
      const program = compile(PONG, { profile });
      const ball = program.instances.find((i) => i.name === "ball1");
      return profile.screenHeight / toNumber(ball?.numbers["speed"] ?? 1);
    });
    // Tolerance is fixed-point rounding, not slack: the spread across consoles
    // is under a microsecond of simulated time. 55vmin is 55% of the shorter
    // side per second, and on every console here the shorter side *is* the
    // height, so a full crossing is 100/55 seconds by construction.
    for (const time of times) expect(time).toBeCloseTo(100 / 55, 4);
  });

  it("gives the paddle the same traverse time on every console", () => {
    for (const id of CONSOLES) {
      const profile = getProfile(id);
      const program = compile(PONG, { profile });
      const paddle = program.instances.find((i) => i.name === "paddle1");
      const traverse = profile.screenWidth / toNumber(paddle?.numbers["speed"] ?? 1);
      expect(traverse, id).toBeCloseTo(1.667, 2);
    }
  });

  it("keeps the paddle covering roughly the same share of the wall", () => {
    for (const id of CONSOLES) {
      const profile = getProfile(id);
      const program = compile(PONG, { profile });
      const paddle = program.instances.find((i) => i.name === "paddle1");
      const share = (toNumber(paddle?.numbers["width"] ?? 0) / profile.screenWidth) * 100;
      // 15% asked for; whole-cell quantisation moves it by at most half a cell.
      expect(share, id).toBeGreaterThan(13);
      expect(share, id).toBeLessThan(17);
    }
  });
});

describe("pong", () => {
  it("compiles for every supported console", () => {
    for (const id of ["gb", "gbc", "nes", "sms", "gg", "md", "snes"]) {
      const program = compile(PONG, { profile: getProfile(id) });
      expect(program.entryScene).toBe("title");
      expect(program.assets).toEqual(["ball.svg", "paddle.svg"]);
    }
  });

  it("starts on the title screen and enters play on A", () => {
    const world = new Sim(compile(PONG, { profile: gb }));
    expect(world.scene).toBe("title");
    world.step({ a: true });
    expect(world.scene).toBe("play");
  });

  it("concedes a point when the player never moves", () => {
    const world = new Sim(compile(PONG, { profile: gb }));
    world.step({ a: true });
    steps(world, 300);
    expect(value(world, "score2", "value")).toBeGreaterThanOrEqual(1);
  });

  it("moves the opponent continuously rather than in blocks", () => {
    // Two failure modes share one metric. On/off steering overshoots by a tick
    // every tick and buzzes; widening the dead zone enough to stop that makes it
    // lurch between rests. Both show up as stop/start events, and proportional
    // steering has almost none — it eases in and lands on target.
    for (const id of ["gb", "md", "snes"]) {
      const world = new Sim(compile(PONG, { profile: getProfile(id) }));
      world.step({ a: true });

      let previous = value(world, "paddle2", "x");
      let wasMoving = false;
      let starts = 0;
      for (let i = 0; i < 600; i += 1) {
        world.step({});
        const x = value(world, "paddle2", "x");
        const moving = Math.abs(x - previous) > 1e-9;
        if (moving && !wasMoving) starts += 1;
        wasMoving = moving;
        previous = x;
      }
      expect(starts, id).toBeLessThanOrEqual(8);
    }
  });

  it("keeps a rally going while the paddle tracks the ball", () => {
    const world = new Sim(compile(PONG, { profile: gb }));
    world.step({ a: true });

    let bounces = 0;
    let previous = world.entity("ball1")?.numbers["ydirection"] ?? 0;
    for (let i = 0; i < 600; i += 1) {
      const ball = world.entity("ball1");
      const paddle = world.entity("paddle1");
      const input: InputState = {};
      if (ball && paddle) {
        const ballCentre = (ball.numbers["x"] ?? 0) + (ball.numbers["width"] ?? 0) / 2;
        const paddleCentre = (paddle.numbers["x"] ?? 0) + (paddle.numbers["width"] ?? 0) / 2;
        if (paddleCentre > ballCentre) input.left = true;
        else if (paddleCentre < ballCentre) input.right = true;
      }
      world.step(input);

      const current = world.entity("ball1")?.numbers["ydirection"] ?? 0;
      if (current !== previous) bounces += 1;
      previous = current;
    }

    expect(bounces).toBeGreaterThan(4);
    expect(value(world, "score2", "value")).toBe(0);
  });
});
