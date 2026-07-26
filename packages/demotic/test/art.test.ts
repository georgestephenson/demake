/**
 * Art binding: the game pipeline's half of doc 15 §The conversion path.
 *
 * The point of the whole tool is that a game's sprites are demade by the same
 * engine that demakes a photograph, so what is checked here is that the art
 * actually *arrives*: in the tile bank, in the OAM entries the runtime writes,
 * and on the screen a real emulator draws. A build that silently fell back to
 * the placeholder block would still pass a trace test, because art is not
 * state — which is exactly why it needs a test of its own.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Gameboy } from "@demake/dmg";

import { artRequests, bindArt } from "../src/codegen/art.js";
import { buildGbRom } from "../src/codegen/gb.js";
import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { BUILTIN_TILES, TILE_BYTES } from "../src/rom/graphics.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const text = (name: string) => readFileSync(join(fixtures, name), "utf8");
const bytes = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));

const pong = () => compile(text("pong.dmt"), { profile: getProfile("gb") });
const pongAssets = () =>
  new Map([
    ["ball.svg", bytes("ball.svg")],
    ["paddle.svg", bytes("paddle.svg")],
    ["pong.title.svg", bytes("pong.title.svg")],
    ["pong.play.svg", bytes("pong.play.svg")],
  ]);

describe("what art a program needs", () => {
  it("asks for each asset once, at the box the game gives it", () => {
    const requests = artRequests(pong());
    // Backdrops are not in here: a picture is bound per *scene*, at the screen's
    // own size, so it has no box for this list to carry.
    expect(requests.map((request) => request.name).sort()).toEqual(["ball.svg", "paddle.svg"]);
    const ball = requests.find((request) => request.name === "ball.svg");
    const paddle = requests.find((request) => request.name === "paddle.svg");
    // One cell for the ball; the paddle is 15% of a 20-cell court, so three.
    expect([ball?.cellsWide, ball?.cellsHigh]).toEqual([1, 1]);
    expect([paddle?.cellsWide, paddle?.cellsHigh]).toEqual([3, 1]);
    expect(requests.every((request) => request.kind === "sprite")).toBe(true);
  });

  it("asks for a level's legend art as background tiles", () => {
    const caves = compile(text(join("games", "caves.dmt")), {
      profile: getProfile("gb"),
      levels: { "cavern.dmtl": text(join("games", "cavern.dmtl")) },
    });
    const requests = artRequests(caves);
    const wall = requests.find((request) => request.name === "rockwall.svg");
    expect(wall?.kind).toBe("tile");
    // Sprites and tiles are converted separately: an object's index 0 is
    // transparency and a tile's is a colour.
    expect(requests.some((request) => request.kind === "sprite")).toBe(true);
  });
});

describe("binding art to a build", () => {
  it("places converted tiles after the built-in bank", () => {
    const bound = bindArt(pong(), pongAssets());
    expect(bound.missing).toEqual([]);
    expect(bound.tiles8).toBeGreaterThan(0);
    expect(bound.extraTiles?.length).toBe(bound.tiles8 * TILE_BYTES);
    for (const art of bound.sprites?.values() ?? []) {
      expect(art.tile).toBeGreaterThanOrEqual(BUILTIN_TILES);
      expect(art.tile + art.width * art.height).toBeLessThanOrEqual(BUILTIN_TILES + bound.tiles8);
    }
  });

  it("names art it was not given rather than drawing something else silently", () => {
    const bound = bindArt(pong(), new Map());
    expect(bound.missing.sort()).toEqual([
      "ball.svg",
      "paddle.svg",
      "pong.play.svg",
      "pong.title.svg",
    ]);
    expect(bound.sprites).toBeUndefined();
  });

  it("puts the converted tiles in the ROM, not just in the plan", () => {
    const built = buildGbRom(pong(), { assets: pongAssets() });
    expect(built.stats.artTiles).toBeGreaterThan(0);
    expect(built.stats.missingArt).toEqual([]);
    const bank = built.symbols.get("TileBank") as number;
    const converted = built.bytes.subarray(
      bank + BUILTIN_TILES * TILE_BYTES,
      bank + (BUILTIN_TILES + built.stats.artTiles) * TILE_BYTES,
    );
    expect(converted.some((byte) => byte !== 0)).toBe(true);
  });

  it("produces the same cartridge every time it converts the same art", () => {
    const first = buildGbRom(pong(), { assets: pongAssets() });
    const second = buildGbRom(pong(), { assets: pongAssets() });
    expect([...first.bytes]).toEqual([...second.bytes]);
  });
});

describe("the art on screen", () => {
  /** Run to the play scene and read OAM back out of a real machine. */
  function play(assets?: Map<string, Uint8Array>): { machine: Gameboy; oam: Uint8Array } {
    const built = buildGbRom(pong(), assets ? { assets } : {});
    const machine = new Gameboy(built.bytes);
    for (let frame = 0; frame < 200; frame += 1) {
      machine.setButtons(frame > 5 && frame < 12 ? ["a"] : []);
      machine.runFrame();
    }
    return { machine, oam: machine.readMemory(0xfe00, 0xa0) };
  }

  it("gives each object the tiles its own art was converted into", () => {
    const built = buildGbRom(pong(), { assets: pongAssets() });
    const ball = built.stats; // keeps the build in scope for the message below
    const { oam } = play(pongAssets());
    const used = new Set<number>();
    for (let entry = 0; entry < 40; entry += 1) {
      // A parked entry sits at y = 0, which is off the top of the screen.
      if (oam[entry * 4] === 0) continue;
      used.add(oam[entry * 4 + 2] as number);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const tile of used) {
      expect(tile).toBeGreaterThanOrEqual(BUILTIN_TILES);
      expect(tile).toBeLessThan(BUILTIN_TILES + ball.artTiles);
    }
  });

  it("draws more than one shade, so the art is art and not a block", () => {
    const { machine } = play(pongAssets());
    const shades = new Set<string>();
    const frame = machine.framebuffer;
    for (let at = 0; at < frame.length; at += 4) {
      shades.add(`${frame[at]},${frame[at + 1]},${frame[at + 2]}`);
    }
    expect(shades.size).toBeGreaterThan(2);
  });

  it("still plays with no art at all, drawing the built-in block", () => {
    const { oam } = play();
    const drawn = [...Array(40).keys()].filter((entry) => oam[entry * 4] !== 0);
    expect(drawn.length).toBeGreaterThan(0);
    for (const entry of drawn) expect(oam[entry * 4 + 2]).toBeLessThan(BUILTIN_TILES);
  });
});
