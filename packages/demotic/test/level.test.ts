import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { levelAssets, parseLevel, tileAt } from "../src/level/parse.js";

const CAVERN = readFileSync(
  fileURLToPath(new URL("../fixtures/games/cavern.dmtl", import.meta.url)),
  "utf8",
);

function level(...lines: string[]) {
  return parseLevel(lines.join("\n"));
}

describe(".dmtl", () => {
  it("reads the legend and the grid", () => {
    const parsed = parseLevel(CAVERN);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.width).toBe(60);
    expect(parsed.height).toBe(30);
    expect(parsed.tiles.map((t) => t.name)).toEqual(["wall", "ledge", "spikes", "coin", "exit"]);
    // Spikes are named but not solid: a rule fires on them, and nothing stops
    // the hero falling in. That split is the tile equivalent of `visible`.
    expect(parsed.tiles.filter((t) => t.solid).map((t) => t.name)).toEqual(["wall", "ledge"]);
  });

  it("is bigger than any target screen, which is the point of it", () => {
    // The largest playfield in the set is the Mega Drive's 40x28 cells, so a
    // level that scrolls on every console has to clear both.
    expect(parseLevel(CAVERN).width).toBeGreaterThan(40);
    expect(parseLevel(CAVERN).height).toBeGreaterThan(28);
  });

  it("collects the art each tile needs", () => {
    expect(levelAssets(parseLevel(CAVERN))).toEqual([
      "brick.svg",
      "coin.svg",
      "exit.svg",
      "ledge.svg",
      "spikes.svg",
    ]);
  });

  it("addresses cells by column and row, with space meaning empty", () => {
    const parsed = level("tile # wall solid", "tile o coin", "map", "#o#", "# #");
    expect(tileAt(parsed, 0, 0)?.name).toBe("wall");
    expect(tileAt(parsed, 1, 0)?.name).toBe("coin");
    expect(tileAt(parsed, 1, 1)).toBeUndefined();
    expect(tileAt(parsed, 9, 9)).toBeUndefined();
  });

  it("pads short rows rather than rejecting them", () => {
    // A run of trailing empty cells is invisible in an editor; failing on it
    // would make the format hostile to the tools it exists to be edited with.
    const parsed = level("tile # wall", "map", "####", "#");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.width).toBe(4);
    expect(parsed.rows[1]).toBe("#   ");
  });

  it("does not treat `--` inside the grid as a comment", () => {
    // Every character in the map is a cell, and `-` is a perfectly good tile.
    const parsed = level("tile - rail", "tile # wall", "map", "--#--");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.width).toBe(5);
    expect(tileAt(parsed, 0, 0)?.name).toBe("rail");
  });

  it("strips comments in the legend", () => {
    const parsed = level("-- a note", "tile # wall solid  -- the outer wall", "map", "##");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tiles[0]).toMatchObject({ name: "wall", solid: true });
  });

  it("names an unknown character once, with where to find it", () => {
    const parsed = level("tile # wall", "map", "##?#", "###?");
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]?.code).toBe("E_UNKNOWN_TILE");
    expect(parsed.diagnostics[0]?.message).toContain("column 3");
    expect(parsed.diagnostics[0]?.hint).toContain("tile ?");
  });

  it("rejects a legend that reuses a character or a name", () => {
    expect(level("tile # wall", "tile # rock", "map", "#").diagnostics[0]?.code).toBe(
      "E_DUPLICATE_TILE",
    );
    expect(level("tile # wall", "tile = wall", "map", "#").diagnostics[0]?.code).toBe(
      "E_DUPLICATE_TILE",
    );
  });

  it("requires a grid", () => {
    expect(level("tile # wall").diagnostics[0]?.code).toBe("E_LEVEL_NO_MAP");
  });

  it("reports every legend problem in one pass", () => {
    const parsed = level("tile", "tile ## wall", "tile ^", "wibble", "map", "^");
    expect(parsed.diagnostics.map((d) => d.code)).toEqual([
      "E_LEVEL_SYNTAX",
      "E_LEVEL_SYNTAX",
      "E_LEVEL_SYNTAX",
      "E_LEVEL_SYNTAX",
      "E_UNKNOWN_TILE",
    ]);
  });

  it("cannot be made to redefine the empty cell", () => {
    // Whitespace separates a `tile` line's words, so a space simply is not
    // writable as a tile character — `tile   empty` reads as a one-word line.
    const parsed = parseLevel(["tile   empty", "map", "#"].join("\n"));
    expect(parsed.diagnostics[0]?.code).toBe("E_LEVEL_SYNTAX");
    expect(parsed.tiles).toEqual([]);
  });
});
