/**
 * `.dmtl` — the level format.
 *
 * A legend, then a grid drawn in characters:
 *
 *     tile #  wall   solid  brick.svg
 *     tile .  floor         floor.svg
 *     tile o  coin          coin.svg
 *
 *     map
 *     ################
 *     #....o......o..#
 *     #..####...####.#
 *     ################
 *
 * The grid is the level, literally. That is the whole argument for the format:
 * a model can read it, reason about it and edit it in place, because the shape
 * on screen *is* the shape in the file. An array of tile indices is the
 * opposite — unreadable, and something editing one miscounts a column and
 * silently moves a wall.
 *
 * Two consequences follow from taking that seriously:
 *
 *   - **One row per line, however long.** A hundred-cell scrolling level makes a
 *     hundred-character line. Wrapping or chunking it would restore the property
 *     the format exists to avoid.
 *   - **No comments inside the grid.** `--` is a comment in the legend, but
 *     inside the map every character is a cell and `-` is a perfectly good tile.
 *   - **Every line after `map` is a row, blank ones included.** A blank line is
 *     a row of empty cells; treating it as a separator would move every row
 *     below it up one, silently corrupting the shape the format exists to
 *     preserve. The single exception is the empty string a terminating newline
 *     leaves behind, which is an artefact of the file, not a row in it.
 *
 * Tiles are named, and those names are what Demotic rules collide with:
 * `when player touches spikes` reads as a sentence precisely because the level
 * gave that character a name.
 */

import type { Diagnostic } from "../errors.js";

/** One entry in a level's legend. */
export interface TileSpec {
  /** The single character that draws this tile in the grid. */
  char: string;
  /** The name Demotic rules refer to. */
  name: string;
  /** Blocks movement, and is what an object rests on or runs into. */
  solid: boolean;
  /** Art for the tile, demade per console by the image pipeline. */
  art?: string;
  /** 1-indexed line of the `tile` statement, for diagnostics. */
  line: number;
}

/** A parsed `.dmtl` file. */
export interface LevelFile {
  /** Legend entries, in declaration order. */
  tiles: readonly TileSpec[];
  /** Grid rows, right-padded to `width`. A space is empty. */
  rows: readonly string[];
  width: number;
  height: number;
  diagnostics: readonly Diagnostic[];
}

/** Flags a legend entry may carry. */
const FLAGS = new Set(["solid"]);

/** Extensions that mark a word as art rather than a flag. */
const ART = /\.(svg|png|gif|bmp|jpe?g|webp)$/i;

/**
 * The empty cell: no tile, nothing drawn, nothing solid.
 *
 * It cannot be redefined, and needs no guard saying so — whitespace separates
 * the words of a `tile` line, so there is no way to write a space as one.
 */
export const EMPTY = " ";

function strip(line: string): string {
  const at = line.indexOf("--");
  return (at < 0 ? line : line.slice(0, at)).trimEnd();
}

/**
 * Parse a `.dmtl` source file. Never throws; every problem is a diagnostic, and
 * one pass reports all of them.
 */
export function parseLevel(source: string): LevelFile {
  const diagnostics: Diagnostic[] = [];
  const tiles: TileSpec[] = [];
  const rows: string[] = [];
  const byChar = new Map<string, TileSpec>();
  const byName = new Map<string, TileSpec>();
  let inMap = false;

  const fail = (line: number, code: string, message: string, hint?: string): void => {
    diagnostics.push({
      severity: "error",
      code,
      message,
      line,
      ...(hint === undefined ? {} : { hint }),
    });
  };

  const lines = source.split("\n");
  // A file ending in a newline splits to a final empty string. That is the one
  // blank line that is an artefact rather than a row — every other line after
  // `map` is a row, including blank ones, because a level that starts with
  // three rows of sky has to be able to say so.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index] as string;

    if (inMap) {
      // Every character is a cell from here on, so nothing is stripped — not
      // trailing spaces, which are empty cells, and not `--`, which is a
      // perfectly reasonable pair of tiles. Blank lines are kept too, because a
      // row of nothing but empty cells is a row; only the ones bookending the
      // grid are trimmed, below.
      rows.push(raw.replace(/\r$/, ""));
      continue;
    }

    const text = strip(raw).trim();
    if (text === "") continue;

    if (text.toLowerCase() === "map") {
      inMap = true;
      continue;
    }

    const words = text.split(/\s+/);
    if (words[0]?.toLowerCase() !== "tile") {
      fail(
        line,
        "E_LEVEL_SYNTAX",
        `expected \`tile\` or \`map\` but found '${words[0]}'`,
        "a level is a legend of `tile <char> <name>` lines, then `map`, then the grid",
      );
      continue;
    }

    const [, char, name, ...rest] = words;
    if (!char || char.length !== 1) {
      fail(line, "E_LEVEL_SYNTAX", "a tile is drawn by exactly one character");
      continue;
    }
    if (!name) {
      fail(line, "E_LEVEL_SYNTAX", `tile '${char}' needs a name`, "e.g. `tile # wall solid`");
      continue;
    }

    const spec: TileSpec = { char, name: name.toLowerCase(), solid: false, line };
    for (const word of rest) {
      const lower = word.toLowerCase();
      if (FLAGS.has(lower)) {
        spec.solid = spec.solid || lower === "solid";
      } else if (ART.test(word)) {
        spec.art = word;
      } else {
        fail(
          line,
          "E_LEVEL_SYNTAX",
          `'${word}' is not a flag or a piece of art`,
          `flags are: ${[...FLAGS].join(", ")}`,
        );
      }
    }

    const clashChar = byChar.get(spec.char);
    if (clashChar) {
      fail(line, "E_DUPLICATE_TILE", `'${spec.char}' already draws '${clashChar.name}'`);
      continue;
    }
    const clashName = byName.get(spec.name);
    if (clashName) {
      fail(line, "E_DUPLICATE_TILE", `'${spec.name}' is already drawn by '${clashName.char}'`);
      continue;
    }

    byChar.set(spec.char, spec);
    byName.set(spec.name, spec);
    tiles.push(spec);
  }

  if (!inMap) {
    fail(1, "E_LEVEL_NO_MAP", "no `map` line, so the level has no grid");
  }

  // Rows are padded rather than rejected: a trailing run of empty cells is
  // invisible in a text editor, and failing on it would make the format hostile
  // to exactly the tools it is meant to be edited with.
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const padded = rows.map((row) => row.padEnd(width, EMPTY));

  // The first line of the grid is what a reader sees first, so report unknown
  // characters with the coordinates they can actually find.
  const mapStart = lines.findIndex((line) => strip(line).trim().toLowerCase() === "map") + 1;
  const unknown = new Set<string>();
  for (const [row, text] of padded.entries()) {
    for (const [column, char] of [...text].entries()) {
      if (char === EMPTY || byChar.has(char)) continue;
      if (!unknown.has(char)) {
        unknown.add(char);
        fail(
          mapStart + row + 1,
          "E_UNKNOWN_TILE",
          `'${char}' at column ${column + 1} is not in the legend`,
          `declare it with \`tile ${char} <name>\`, or use a space for an empty cell`,
        );
      }
    }
  }

  return { tiles, rows: padded, width, height: padded.length, diagnostics };
}

/** Look up a legend entry by the character that draws it. */
export function tileAt(level: LevelFile, column: number, row: number): TileSpec | undefined {
  if (row < 0 || row >= level.height || column < 0 || column >= level.width) return undefined;
  const char = (level.rows[row] as string)[column];
  if (char === undefined || char === EMPTY) return undefined;
  return level.tiles.find((tile) => tile.char === char);
}

/**
 * Every `.dmtl` file a game's source refers to, in the order it names them.
 *
 * The compiler never reads a file — it is platform-pure, like `@demake/core` —
 * so each edge (CLI, web worker, demo runner) has to resolve the paths itself.
 * This is the one place that says *which* paths, so those edges cannot drift
 * apart on, say, whether `stream` counts.
 */
export function levelFiles(source: string): readonly string[] {
  const files: string[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.replace(/--.*$/, "").trim();
    const match = /^(?:level|stream)\s+.*?\bfrom\s+(.+?)(?:\s+\d[\d.]*\s+(?:wide|tall))?$/i.exec(
      line,
    );
    if (!match) continue;
    for (const file of (match[1] as string).split(",")) {
      const name = file.trim();
      if (name && !files.includes(name)) files.push(name);
    }
  }
  return files;
}

/** Every distinct art file the level references, deduplicated and sorted. */
export function levelAssets(level: LevelFile): readonly string[] {
  return [
    ...new Set(level.tiles.map((tile) => tile.art).filter((art): art is string => !!art)),
  ].sort();
}
