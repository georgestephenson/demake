import { describe, expect, it } from "vitest";

import { check, compile } from "../src/compile.js";
import { GameLangError } from "../src/errors.js";
import { ONE, toNumber } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";

const gb = getProfile("gb");
const md = getProfile("md");

function codes(source: string, profile = gb): string[] {
  return check(source, { profile }).diagnostics.map((d) => d.code);
}

const MINIMAL = ["start play", "scene play", "create object dot (sprite dot.png)"].join("\n");

describe("compile", () => {
  it("folds screen constants per console, so one source targets many playfields", () => {
    const source = [MINIMAL, "create dot d1 in play (x centerx, y screenheight - 1)"].join("\n");

    const onGb = compile(source, { profile: gb }).instances[0];
    const onMd = compile(source, { profile: md }).instances[0];

    // Game Boy: 20x18 cells. Mega Drive: 40x28.
    expect(toNumber(onGb?.numbers["x"] ?? 0)).toBe(10);
    expect(toNumber(onGb?.numbers["y"] ?? 0)).toBe(17);
    expect(toNumber(onMd?.numbers["x"] ?? 0)).toBe(20);
    expect(toNumber(onMd?.numbers["y"] ?? 0)).toBe(27);
  });

  it("uses the overscan-safe height on the NES, not the raw frame", () => {
    // The raw NES frame is 30 cells tall but only 28 are reliably visible.
    const nes = getProfile("nes");
    const source = [MINIMAL, "create dot d1 in play (y screenheight, x rawscreenheight)"].join(
      "\n",
    );
    const instance = compile(source, { profile: nes }).instances[0];
    expect(toNumber(instance?.numbers["y"] ?? 0)).toBe(28);
    expect(toNumber(instance?.numbers["x"] ?? 0)).toBe(30);
  });

  it("expands a compass direction into both axes", () => {
    const source = [MINIMAL, "create dot d1 in play (direction northwest)"].join("\n");
    const instance = compile(source, { profile: gb }).instances[0];
    expect(instance?.numbers["xdirection"]).toBe(-ONE);
    expect(instance?.numbers["ydirection"]).toBe(-ONE);
  });

  it("reads an unquoted asset name as a literal, not as a property access", () => {
    const program = compile([MINIMAL, "create dot d1 in play ()"].join("\n"), { profile: gb });
    expect(program.instances[0]?.strings["sprite"]).toBe("dot.png");
    expect(program.assets).toEqual(["dot.png"]);
  });

  it("resolves declarations in any order", () => {
    const source = [
      "create dot d1 in play (x 1)",
      "start play",
      "create object dot (sprite dot.png)",
      "scene play",
    ].join("\n");
    expect(compile(source, { profile: gb }).instances).toHaveLength(1);
  });

  it("collects every diagnostic rather than stopping at the first", () => {
    const source = [
      "start nowhere",
      "scene play",
      "create object dot (wibble 1)",
      "create dot d1 in play (x nonsense)",
      "control ghost left (xdirection 1)",
    ].join("\n");
    expect(codes(source)).toEqual([
      "E_UNKNOWN_SCENE",
      "E_UNKNOWN_PROP",
      "E_UNKNOWN_NAME",
      "E_UNKNOWN_INSTANCE",
    ]);
  });

  it("names the button set when an unknown button is bound", () => {
    const source = [MINIMAL, "create dot d1 in play ()", "control d1 x (xdirection 1)"].join("\n");
    const [diagnostic] = check(source, { profile: gb }).diagnostics;
    expect(diagnostic?.code).toBe("E_UNKNOWN_ACTION");
    expect(diagnostic?.hint).toContain("left, right, up, down, a, b, start");
  });

  it("refuses to assign a derived property, and says which to use instead", () => {
    const source = [
      MINIMAL,
      "create dot d1 in play ()",
      "when d1 hits screenleft then d1.centerx as 0",
    ].join("\n");
    const [diagnostic] = check(source, { profile: gb }).diagnostics;
    expect(diagnostic?.code).toBe("E_UNKNOWN_PROP");
    expect(diagnostic?.message).toContain("derived");
  });

  it("requires an owner for a property when the rule has no subject", () => {
    const source = [MINIMAL, "create dot d1 in play ()", "when a pressed then x as 0"].join("\n");
    expect(codes(source)).toEqual(["E_UNQUALIFIED_TARGET"]);
  });

  it("warns that `start` is not a face button on the Master System", () => {
    const source = [MINIMAL, "create dot d1 in play ()", "control d1 start (speed 0)"].join("\n");
    expect(codes(source, getProfile("sms"))).toEqual(["W_START_MAPPING"]);
    expect(codes(source, gb)).toEqual([]);
  });

  it("fails a scene that needs more hardware sprites than the console has", () => {
    // 12 objects of 4x2 cells = 96 sprites; a Game Boy has 40, a Mega Drive 80.
    const objects = Array.from({ length: 12 }, (_, i) => `create big b${i} in play (x ${i}, y 1)`);
    const source = [
      "start play",
      "scene play",
      "create object big (width 4, height 2, sprite big.png)",
      ...objects,
    ].join("\n");

    expect(() => compile(source, { profile: gb })).toThrow(GameLangError);
    const diagnostic = check(source, { profile: gb }).diagnostics.find(
      (d) => d.code === "E_SPRITE_BUDGET",
    );
    expect(diagnostic?.message).toContain("96 hardware sprites");
    expect(diagnostic?.message).toContain("provides 40");
  });

  it("warns before it fails, once a scene passes three quarters of the budget", () => {
    const objects = Array.from({ length: 8 }, (_, i) => `create big b${i} in play (x ${i}, y 1)`);
    const source = [
      "start play",
      "scene play",
      "create object big (width 4, height 1, sprite big.png)",
      ...objects,
    ].join("\n");
    // 32 of 40 sprites on a Game Boy: allowed, but worth saying out loud.
    expect(codes(source, gb)).toEqual(["W_SPRITE_BUDGET"]);
    // The same scene is comfortable on a Mega Drive's 80.
    expect(codes(source, md)).toEqual([]);
  });

  it("resolves relative units against each console's playfield", () => {
    const source = [
      "start play",
      "scene play",
      "create object dot (sprite dot.png)",
      "create dot d1 in play (x 50vw, y 25vh, speed 40vmin)",
    ].join("\n");

    // Game Boy 20x18 cells; Mega Drive 40x28.
    const onGb = compile(source, { profile: gb }).instances[0];
    expect(toNumber(onGb?.numbers["x"] ?? 0)).toBe(10);
    expect(toNumber(onGb?.numbers["y"] ?? 0)).toBe(4.5);
    expect(toNumber(onGb?.numbers["speed"] ?? 0)).toBeCloseTo(7.2, 3);

    const onMd = compile(source, { profile: md }).instances[0];
    expect(toNumber(onMd?.numbers["x"] ?? 0)).toBe(20);
    expect(toNumber(onMd?.numbers["y"] ?? 0)).toBe(7);
    expect(toNumber(onMd?.numbers["speed"] ?? 0)).toBeCloseTo(11.2, 3);
  });

  it("keeps an unsuffixed number in cells, and accepts `cell`/`cells`", () => {
    const source = [MINIMAL, "create dot d1 in play (x 3, y 3 cells, width 2 cell)"].join("\n");
    const instance = compile(source, { profile: md }).instances[0];
    expect(toNumber(instance?.numbers["x"] ?? 0)).toBe(3);
    expect(toNumber(instance?.numbers["y"] ?? 0)).toBe(3);
    expect(toNumber(instance?.numbers["width"] ?? 0)).toBe(2);
  });

  it("quantises sizes to whole cells, because sprites come in whole cells", () => {
    // 15% of 32 cells is 4.8 — a collision box no console can draw.
    const source = [MINIMAL, "create dot d1 in play (width 15vw, height 15vw)"].join("\n");
    const onNes = compile(source, { profile: getProfile("nes") }).instances[0];
    expect(toNumber(onNes?.numbers["width"] ?? 0)).toBe(5);

    const onGb = compile(source, { profile: gb }).instances[0];
    expect(toNumber(onGb?.numbers["width"] ?? 0)).toBe(3);
  });

  it("never quantises a size to nothing", () => {
    const source = [MINIMAL, "create dot d1 in play (width 1vw, height 1vw)"].join("\n");
    const instance = compile(source, { profile: gb }).instances[0];
    expect(toNumber(instance?.numbers["width"] ?? 0)).toBe(1);
  });

  it("warns when width and height are sized against different screen axes", () => {
    const source = [MINIMAL, "create dot d1 in play (width 10vw, height 10vh)"].join("\n");
    const [diagnostic] = check(source, { profile: gb }).diagnostics;
    expect(diagnostic?.code).toBe("W_ASPECT_MISMATCH");
    expect(diagnostic?.hint).toContain("vmin");
    // Same-axis sizing, and vmin, are both fine.
    expect(
      codes([MINIMAL, "create dot d1 in play (width 10vmin, height 10vmin)"].join("\n")),
    ).toEqual([]);
  });

  it("folds abs() and reports a wrong argument count", () => {
    const source = [MINIMAL, "create dot d1 in play (x abs(0 - 4))"].join("\n");
    expect(toNumber(compile(source, { profile: gb }).instances[0]?.numbers["x"] ?? 0)).toBe(4);

    const bad = [MINIMAL, "create dot d1 in play (x abs(1, 2))"].join("\n");
    expect(check(bad, { profile: gb }).diagnostics[0]?.code).toBe("E_ARITY");
  });

  it("still reads a parenthesised value as a named pair, not a call", () => {
    const source = [MINIMAL, "create dot d1 in play (y (screenheight - 1))"].join("\n");
    expect(toNumber(compile(source, { profile: gb }).instances[0]?.numbers["y"] ?? 0)).toBe(17);
  });

  it("rejects a non-constant initial value with an actionable hint", () => {
    const source = [MINIMAL, "create dot d1 in play (x 1)", "create dot d2 in play (x d1.x)"].join(
      "\n",
    );
    const diagnostic = check(source, { profile: gb }).diagnostics[0];
    expect(diagnostic?.code).toBe("E_NOT_CONSTANT");
    expect(diagnostic?.hint).toContain("when");
  });

  it("catches an object too large for the playfield", () => {
    const source = [
      "start play",
      "scene play",
      "create object wall (width 30, height 1, sprite w.png)",
      "create wall w1 in play ()",
    ].join("\n");
    // 30 cells fits a 32-cell NES court but not a 20-cell Game Boy one.
    expect(codes(source, gb)).toContain("E_OBJECT_TOO_WIDE");
    expect(codes(source, getProfile("nes"))).not.toContain("E_OBJECT_TOO_WIDE");
  });

  it("warns about an object that starts outside the playfield", () => {
    const source = [MINIMAL, "create dot d1 in play (x 24, y 1)"].join("\n");
    expect(codes(source, gb)).toContain("W_OFFSCREEN_START");
    expect(codes(source, md)).not.toContain("W_OFFSCREEN_START");
  });

  it("warns about a speed too small to move anything in a tick", () => {
    const source = [MINIMAL, "create dot d1 in play (speed 0.0001)"].join("\n");
    expect(codes(source, gb)).toContain("W_SUBTICK_SPEED");
  });

  it("warns when a mover can tunnel through what it collides with", () => {
    const source = [
      "start play",
      "scene play",
      "create object bullet (width 1, height 1, speed 300, sprite b.png)",
      "create object wall (width 4, height 1, sprite w.png)",
      "create bullet b1 in play (x 1, y 1, direction east)",
      "create wall w1 in play (x 10, y 1)",
      "when bullet hits wall then speed as 0",
    ].join("\n");
    // 300 cells/second at 60 Hz is 5 cells a tick, through a 1-cell-thick wall.
    const diagnostic = check(source, { profile: md }).diagnostics.find(
      (d) => d.code === "W_TUNNELLING",
    );
    expect(diagnostic?.message).toContain("pass straight through");
  });

  it("warns when text runs off the edge of a small playfield", () => {
    const source = [
      "start play",
      "scene play",
      'create text t1 in play (x 2, y 1, text "a very long line of text indeed")',
    ].join("\n");
    expect(codes(source, gb)).toContain("W_TEXT_TOO_WIDE");
    expect(codes(source, md)).not.toContain("W_TEXT_TOO_WIDE");
  });

  it("warns when the cell grid moves a relative size a long way", () => {
    // 8% of a 20-cell Game Boy court is 1.6 cells, which rounds to 2 — a 25%
    // move. The same request on a 40-cell court is 3.2, which barely moves.
    const source = [MINIMAL, "create dot d1 in play (width 8vw, height 1)"].join("\n");
    expect(codes(source, gb)).toContain("W_SIZE_ROUNDING");
    expect(codes(source, md)).not.toContain("W_SIZE_ROUNDING");
  });

  it("clamps, mins and maxes", () => {
    const source = [MINIMAL, "create dot d1 in play (x clamp(9, 0, 4), y max(1, min(7, 3)))"].join(
      "\n",
    );
    const instance = compile(source, { profile: gb }).instances[0];
    expect(toNumber(instance?.numbers["x"] ?? 0)).toBe(4);
    expect(toNumber(instance?.numbers["y"] ?? 0)).toBe(3);
  });

  it("rejects a second camera in a scene rather than letting it win silently", () => {
    const source = [
      MINIMAL,
      "create dot d1 in play ()",
      "create dot d2 in play (x 4)",
      "camera follows d1",
      "camera follows d2",
    ].join("\n");
    expect(codes(source)).toContain("E_DUPLICATE_CAMERA");
  });

  it("allows one camera per scene", () => {
    const source = [
      MINIMAL,
      "scene bonus",
      "create dot d1 in play ()",
      "create dot d2 in bonus ()",
      "camera follows d1 in play",
      "camera follows d2 in bonus",
    ].join("\n");
    expect(codes(source)).not.toContain("E_DUPLICATE_CAMERA");
  });

  it("rejects two bindings writing one property from one button", () => {
    // Each `on hold` binding restores what it overwrote, so two of them on one
    // property unwind into whichever value the other snapshotted.
    const source = [
      MINIMAL,
      "create dot d1 in play ()",
      "control d1 left (xdirection -1)",
      "control d1 left (xdirection 1)",
    ].join("\n");
    expect(codes(source)).toContain("E_DUPLICATE_CONTROL");
  });

  it("allows one button to set different properties, or the same one on another edge", () => {
    const source = [
      MINIMAL,
      "create dot d1 in play ()",
      "control d1 a (ydirection -1)",
      "control d1 a (speed 4)",
      "control d1 a (ydirection 1) on release",
    ].join("\n");
    expect(codes(source)).not.toContain("E_DUPLICATE_CONTROL");
  });

  it("reports the text of an error through GameLangError", () => {
    try {
      compile("start nowhere", { profile: gb });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GameLangError);
      expect((error as GameLangError).diagnostics.length).toBeGreaterThan(0);
    }
  });
});
