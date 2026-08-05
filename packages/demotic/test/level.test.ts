import { describe, expect, it } from "vitest";

import { levelAssets, parseLevel, tileAt } from "../src/level/parse.js";
import { projectText } from "./_projects.js";

const CAVERN = projectText("caves", "levels/cavern.dmtl");

function level(...lines: string[]) {
  return parseLevel(lines.join("\n"));
}

describe(".dmtl", () => {
  it("reads the legend and the grid", () => {
    const parsed = parseLevel(CAVERN);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.width).toBe(60);
    expect(parsed.height).toBe(30);
    expect(parsed.tiles.map((t) => t.name)).toEqual(["wall", "ledge", "spikes", "exit", "air"]);
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

  it("keeps every ledge in the cavern within a jump of one below it", () => {
    // The cavern is a staircase and its step is the hero's jump: five cells of
    // rise, of which the top one is spent getting *above* the ledge, so a pad
    // four rows below a ledge is a step and one six rows below it is scenery.
    // Both facts are geometry rather than taste, and the exit and one coin sat
    // on ledges that had neither — flush under the roof, six rows above the
    // nearest pad — which made a third of the cavern decoration.
    //
    // Two conditions, and neither is the whole story: a jump also has to reach
    // horizontally, and only the interpreter can answer that. What this pins is
    // what a level edit can break without anyone noticing.
    const parsed = parseLevel(CAVERN);
    // By the legend's own name rather than by the character it happens to be
    // drawn with, which is the whole point of a legend.
    const isLedge = (column: number, row: number) => tileAt(parsed, column, row)?.name === "ledge";
    const solid = (column: number, row: number) => tileAt(parsed, column, row)?.solid === true;

    const ledges: { row: number; from: number; to: number }[] = [];
    for (let row = 0; row < parsed.height; row += 1) {
      for (let column = 0; column < parsed.width; column += 1) {
        if (!isLedge(column, row)) continue;
        const from = column;
        while (isLedge(column, row)) column += 1;
        ledges.push({ row, from, to: column - 1 });
      }
    }

    // The floor and the rock under it are what everything else is climbed from.
    const floor = Math.max(...ledges.map((l) => l.row));
    const problems: string[] = [];
    for (const ledge of ledges.filter((l) => l.row < floor - 1)) {
      const where = `row ${ledge.row}, columns ${ledge.from}-${ledge.to}`;
      // Room to land: the hero is two cells tall and has to be *above* the
      // ledge before it can come down on it, so the three rows over it are its.
      for (let row = ledge.row - 3; row < ledge.row; row += 1) {
        for (let column = ledge.from; column <= ledge.to; column += 1) {
          if (solid(column, row)) problems.push(`${where}: no room to land, row ${row} is solid`);
        }
      }
      // Something to jump from: a surface one to four rows below it.
      if (!ledges.some((l) => l.row > ledge.row && l.row <= ledge.row + 4)) {
        problems.push(`${where}: nothing to jump from within four rows`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("collects the art each tile needs", () => {
    expect(levelAssets(parseLevel(CAVERN))).toEqual([
      "air.svg",
      "exit.svg",
      "rockwall.svg",
      "spikes.svg",
      "stone.svg",
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

  it("takes the same space-before rule for a comment that the language does", () => {
    // Truncating at any `--` would leave `brick`, which is then rejected for
    // being neither a flag nor a piece of art — an error naming the wrong thing.
    const parsed = level("tile # wall solid brick--old.svg", "map", "##");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tiles[0]).toMatchObject({ name: "wall", art: "brick--old.svg" });
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
