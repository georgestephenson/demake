/**
 * The level editor's text model (doc 19 §The level editor).
 *
 * The editor is a view over `.dmtl`, not a second format, so the properties that
 * matter are all about what it *does not* do to a file. `.dmtl` is literal — the
 * grid in the file is the grid on screen — and every rule below is a way an
 * editor could quietly corrupt that while looking like it worked.
 */

import { describe, expect, it } from "vitest";

import { parseLevel, tileAt } from "@demake/demotic";

import {
  addLegend,
  cellAt,
  fillRect,
  floodFill,
  freeChars,
  gridWidth,
  joinLevel,
  legendLine,
  remapChar,
  removeLegend,
  resizeGrid,
  setCell,
  setLegend,
  splitLevel,
} from "../src/lib/dmtl.js";

const LEVEL = `-- A room, with a comment above the legend.
tile # wall solid brick
tile ^ spikes
tile o coin

map
##########
#   o    #

#  ^^^   #
##########
`;

const round = (text: string) => joinLevel(splitLevel(text));

describe("what it must never do to a file", () => {
  it("gives back a file it did not change, byte for byte", () => {
    expect(round(LEVEL)).toBe(LEVEL);
  });

  it("keeps a blank line inside the grid, because it is a row of empty cells", () => {
    // Dropping it would move every row below up one, which silently corrupts the
    // shape the format exists to preserve.
    const level = splitLevel(LEVEL);
    expect(level.rows).toHaveLength(5);
    expect(level.rows[2]).toBe("");
    expect(parseLevel(joinLevel(level)).height).toBe(5);
  });

  it("keeps trailing spaces, because they are cells", () => {
    const ragged = "tile # wall solid\n\nmap\n##   \n#    \n";
    expect(round(ragged)).toBe(ragged);
    const level = splitLevel(ragged);
    expect(level.rows[0]).toBe("##   ");
  });

  it("keeps a file with no trailing newline exactly as it found it", () => {
    const blunt = "tile # wall solid\n\nmap\n###\n###";
    expect(round(blunt)).toBe(blunt);
  });

  it("keeps comments and blank lines in the legend", () => {
    const level = splitLevel(LEVEL);
    expect(level.head[0]).toBe("-- A room, with a comment above the legend.");
    expect(level.head[4]).toBe("");
  });

  it("changes only the row it painted", () => {
    const before = splitLevel(LEVEL);
    const after = setCell(before, 1, 4, "#");
    expect(after.rows[1]).toBe("#   #    #");
    // Every other line is the same object it was.
    expect(after.head).toBe(before.head);
    expect(after.rows[0]).toBe(before.rows[0]);
    expect(after.rows[3]).toBe(before.rows[3]);
  });
});

describe("painting", () => {
  it("pads a short row rather than refusing the cell", () => {
    // Rows are ragged in the file and only the parser squares them up, so
    // painting past the end of a short one has to mean something.
    const level = setCell(splitLevel(LEVEL), 2, 5, "o");
    expect(level.rows[2]).toBe("     o");
    expect(tileAt(parseLevel(joinLevel(level)), 5, 2)?.name).toBe("coin");
  });

  it("fills a rectangle in either drag direction", () => {
    const a = fillRect(splitLevel(LEVEL), { row: 1, column: 1 }, { row: 3, column: 3 }, "#");
    const b = fillRect(splitLevel(LEVEL), { row: 3, column: 3 }, { row: 1, column: 1 }, "#");
    expect(joinLevel(a)).toBe(joinLevel(b));
    expect(a.rows[1]).toBe("####o    #");
  });

  it("floods the region drawn with one character and stops at the walls", () => {
    const level = splitLevel(LEVEL);
    const filled = floodFill(level, 1, 1, "~", gridWidth(level));
    // The room's interior fills; the wall row above does not.
    expect(filled.rows[0]).toBe("##########");
    expect(filled.rows[1]).toBe("#~~~o~~~~#");
    // …and the blank row, which is all empty cells, is reached through the gap.
    expect(filled.rows[2]).toBe("~~~~~~~~~~");
  });

  it("does nothing when flooding with what is already there", () => {
    const level = splitLevel(LEVEL);
    expect(floodFill(level, 0, 0, "#", gridWidth(level))).toBe(level);
  });

  it("reads past the end of a short row as empty", () => {
    const level = splitLevel(LEVEL);
    expect(cellAt(level, 2, 4)).toBe(" ");
    expect(cellAt(level, 0, 0)).toBe("#");
  });
});

describe("resizing", () => {
  it("pads with empty cells and cuts from the end", () => {
    const level = resizeGrid(splitLevel(LEVEL), 12, 6);
    expect(level.rows).toHaveLength(6);
    expect(level.rows.every((row) => row.length === 12)).toBe(true);
    // Anchored top-left: the first row is still the first row.
    expect(level.rows[0]).toBe("##########  ");
    const smaller = resizeGrid(level, 4, 2);
    expect(smaller.rows).toEqual(["####", "#   "]);
  });

  it("gives a file with no grid one", () => {
    const level = resizeGrid(splitLevel("tile # wall solid\n"), 3, 2);
    expect(joinLevel(level)).toContain("map\n");
    expect(parseLevel(joinLevel(level)).width).toBe(3);
  });
});

describe("the legend", () => {
  it("writes an entry in the spelling the parser reads back", () => {
    expect(legendLine({ char: "#", name: "wall", solid: true, art: "brick.svg" })).toBe(
      "tile # wall solid brick.svg",
    );
    expect(legendLine({ char: "o", name: "coin", solid: false })).toBe("tile o coin");
  });

  it("rewrites one entry and leaves its comment alone", () => {
    const level = setLegend(splitLevel(LEVEL), 2, {
      char: "#",
      name: "wall",
      solid: true,
      art: "stone.svg",
    });
    const text = joinLevel(level);
    expect(text).toContain("-- A room, with a comment above the legend.");
    expect(text).toContain("tile # wall solid stone.svg");
    expect(text).toContain("tile ^ spikes");
    expect(parseLevel(text).diagnostics).toEqual([]);
  });

  it("adds an entry after the last tile line, not at the top", () => {
    const level = addLegend(splitLevel(LEVEL), { char: "=", name: "ledge", solid: true });
    const lines = joinLevel(level).split("\n");
    expect(lines[0]).toBe("-- A room, with a comment above the legend.");
    expect(lines[4]).toBe("tile = ledge solid");
    expect(parseLevel(joinLevel(level)).tiles).toHaveLength(4);
  });

  it("removes an entry without touching the grid", () => {
    const level = removeLegend(splitLevel(LEVEL), 4);
    const parsed = parseLevel(joinLevel(level));
    expect(parsed.tiles.map((one) => one.name)).toEqual(["wall", "spikes"]);
    // The cells drawn with it are left as they were: the compiler reports them,
    // which is a better answer than an editor silently erasing part of a level.
    expect(joinLevel(level)).toContain("#   o    #");
  });

  it("redraws the grid when a tile's character changes", () => {
    // The legend's character and the map's characters are one name for one
    // tile, so a rename that stopped at the legend would orphan every cell.
    const renamed = setLegend(splitLevel(LEVEL), 2, {
      char: "W",
      name: "wall",
      solid: true,
      art: "brick",
    });
    const level = remapChar(renamed, "#", "W");
    const parsed = parseLevel(joinLevel(level));
    expect(parsed.diagnostics).toEqual([]);
    expect(level.rows[0]).toBe("WWWWWWWWWW");
    expect(level.rows[1]).toBe("W   o    W");
    expect(tileAt(parsed, 0, 0)?.name).toBe("wall");
  });

  it("leaves rows the character never appears in exactly as they were", () => {
    const level = splitLevel(LEVEL);
    const remapped = remapChar(level, "o", "$");
    expect(remapped.rows[0]).toBe(level.rows[0]);
    expect(remapped.rows[1]).toBe("#   $    #");
    expect(remapped.head).toBe(level.head);
    // …and a character the grid does not use changes nothing at all.
    expect(remapChar(level, "z", "Z")).toBe(level);
    expect(remapChar(level, "#", "#")).toBe(level);
  });

  it("offers only characters the legend has not taken", () => {
    const free = freeChars(parseLevel(LEVEL).tiles);
    expect(free).not.toContain("#");
    expect(free).not.toContain("^");
    expect(free).not.toContain("o");
    expect(free[0]).toBe("*");
  });
});

describe("the file stays valid", () => {
  it("parses cleanly after a session of edits", () => {
    let level = splitLevel(LEVEL);
    level = addLegend(level, { char: "=", name: "ledge", solid: true, art: "ledge.svg" });
    level = resizeGrid(level, 12, 6);
    level = fillRect(level, { row: 5, column: 0 }, { row: 5, column: 11 }, "=");
    level = setCell(level, 1, 2, "^");
    const text = joinLevel(level);
    const parsed = parseLevel(text);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.width).toBe(12);
    expect(parsed.height).toBe(6);
    expect(tileAt(parsed, 0, 5)?.name).toBe("ledge");
    expect(tileAt(parsed, 2, 1)?.name).toBe("spikes");
  });
});
