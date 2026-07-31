/**
 * Editing a `.dmtl` as text (doc 19 §The level editor).
 *
 * The editor is a **view over the format, never a second one**: the file it
 * writes is the file the compiler reads, and a level stays hand-editable whether
 * or not the editor ever touched it. That is why nothing here round-trips through
 * a parsed model — every operation rewrites *only the lines it changes* and
 * leaves the rest of the file byte-identical, comments, spacing and all.
 *
 * Three things `.dmtl`'s literalness forbids, each of which this file is written
 * to make impossible rather than merely unlikely (doc 19, AGENTS.md §Working on
 * Demotic):
 *
 * - **A blank line inside the grid is a row of empty cells**, not a separator.
 *   Dropping one moves every row below it up, which silently corrupts the shape
 *   the format exists to preserve.
 * - **One row per line, however long.** No reflow, no wrapping, and no trimming
 *   of trailing spaces inside the grid — trailing spaces are cells.
 * - **A file it did not change comes back byte-identical.** Opening a level and
 *   saving the project must not rewrite it.
 */

import { EMPTY, parseLevel, type TileSpec } from "@demake/demotic";

/** A `.dmtl` split into the parts an editor moves independently. */
export interface LevelText {
  /** Everything before `map`, verbatim — the legend and its comments. */
  head: readonly string[];
  /** The `map` line as it was written, so its own spelling survives. */
  marker: string;
  /** Every line after `map`. Each is a row, blank ones included. */
  rows: readonly string[];
  /** True when the file ended with a newline, so writing one back keeps it. */
  trailingNewline: boolean;
  /** Absent when the file has no `map` line at all — nothing to paint yet. */
  hasMap: boolean;
}

/** Split a level's text without interpreting any of it. */
export function splitLevel(text: string): LevelText {
  const lines = text.split("\n");
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();

  const at = lines.findIndex((line) => line.replace(/\r$/, "").trim().toLowerCase() === "map");
  if (at < 0) {
    return { head: lines, marker: "map", rows: [], trailingNewline, hasMap: false };
  }
  return {
    head: lines.slice(0, at),
    marker: lines[at] as string,
    rows: lines.slice(at + 1),
    trailingNewline,
    hasMap: true,
  };
}

/** Put one back together, changing nothing it was not asked to. */
export function joinLevel(level: LevelText): string {
  const lines = level.hasMap
    ? [...level.head, level.marker, ...level.rows]
    : [...level.head, ...level.rows];
  return lines.join("\n") + (level.trailingNewline ? "\n" : "");
}

/** The grid's width: the longest row, since rows are ragged until painted. */
export function gridWidth(level: LevelText): number {
  return level.rows.reduce((wide, row) => Math.max(wide, row.length), 0);
}

/**
 * Paint one cell.
 *
 * A row shorter than the column is padded with empty cells first — a level's
 * rows are ragged in the file and only the parser squares them up, so painting
 * at column 40 of a 12-character row has to mean something.
 */
export function setCell(level: LevelText, row: number, column: number, char: string): LevelText {
  if (row < 0 || row >= level.rows.length || column < 0) return level;
  const line = level.rows[row] as string;
  const padded = line.length > column ? line : line + EMPTY.repeat(column - line.length);
  const next = padded.slice(0, column) + char + padded.slice(column + 1);
  if (next === line) return level;
  const rows = [...level.rows];
  rows[row] = next;
  return { ...level, rows };
}

/** Paint a rectangle, which is what a drag does. */
export function fillRect(
  level: LevelText,
  from: { row: number; column: number },
  to: { row: number; column: number },
  char: string,
): LevelText {
  let next = level;
  const rows = [Math.min(from.row, to.row), Math.max(from.row, to.row)] as const;
  const columns = [Math.min(from.column, to.column), Math.max(from.column, to.column)] as const;
  for (let row = rows[0]; row <= rows[1]; row += 1) {
    for (let column = columns[0]; column <= columns[1]; column += 1) {
      next = setCell(next, row, column, char);
    }
  }
  return next;
}

/** What is drawn at a cell, or the empty character past the end of a short row. */
export function cellAt(level: LevelText, row: number, column: number): string {
  const line = level.rows[row];
  if (line === undefined) return EMPTY;
  return line[column] ?? EMPTY;
}

/**
 * Flood fill from one cell, over the region drawn with the same character.
 *
 * Four-connected and bounded by the grid the editor is showing, which is the
 * squared-up one — otherwise a fill would run off the end of a short row and
 * stop somewhere that looks arbitrary.
 */
export function floodFill(
  level: LevelText,
  row: number,
  column: number,
  char: string,
  width: number,
): LevelText {
  const target = cellAt(level, row, column);
  if (target === char) return level;
  let next = level;
  const seen = new Set<string>();
  const queue: [number, number][] = [[row, column]];
  while (queue.length > 0) {
    const [r, c] = queue.pop() as [number, number];
    if (r < 0 || r >= level.rows.length || c < 0 || c >= width) continue;
    const key = `${String(r)},${String(c)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (cellAt(next, r, c) !== target) continue;
    next = setCell(next, r, c, char);
    queue.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]);
  }
  return next;
}

/**
 * Change the grid's size.
 *
 * Growing pads with empty cells; shrinking cuts. Rows are added and removed at
 * the *end*, because a grid is anchored at its top-left — inserting at the top
 * would move every coordinate in the game that refers to it.
 */
export function resizeGrid(level: LevelText, width: number, height: number): LevelText {
  const rows: string[] = [];
  for (let row = 0; row < height; row += 1) {
    const line = level.rows[row] ?? "";
    rows.push(
      line.length >= width ? line.slice(0, width) : line + EMPTY.repeat(width - line.length),
    );
  }
  return { ...level, rows, hasMap: true };
}

/** One legend entry as the editor edits it. */
export interface LegendEntry {
  char: string;
  name: string;
  solid: boolean;
  art?: string;
}

/** A legend entry as one `tile` line, in the canonical spelling. */
export function legendLine(entry: LegendEntry): string {
  const parts = ["tile", entry.char, entry.name];
  if (entry.solid) parts.push("solid");
  if (entry.art !== undefined && entry.art !== "") parts.push(entry.art);
  return parts.join(" ");
}

/** The legend, read by the engine's own parser rather than a second one. */
export function legendOf(text: string): readonly TileSpec[] {
  return parseLevel(text).tiles;
}

/**
 * Rewrite one legend entry, in place.
 *
 * `line` is the 1-indexed source line the parser reported, so the entry that is
 * rewritten is the one that was clicked even where two share a name. Only that
 * line changes; a comment above it is untouched.
 */
export function setLegend(level: LevelText, line: number, entry: LegendEntry): LevelText {
  const at = line - 1;
  if (at < 0 || at >= level.head.length) return level;
  const head = [...level.head];
  head[at] = legendLine(entry);
  return { ...level, head };
}

/** Add a legend entry, after the last `tile` line the file has. */
export function addLegend(level: LevelText, entry: LegendEntry): LevelText {
  const head = [...level.head];
  let after = -1;
  for (let index = 0; index < head.length; index += 1) {
    if ((head[index] as string).trim().toLowerCase().startsWith("tile ")) after = index;
  }
  head.splice(after + 1, 0, legendLine(entry));
  return { ...level, head };
}

/** Remove a legend entry by its source line. Cells drawn with it are left alone. */
export function removeLegend(level: LevelText, line: number): LevelText {
  const at = line - 1;
  if (at < 0 || at >= level.head.length) return level;
  const head = [...level.head];
  head.splice(at, 1);
  return { ...level, head };
}

/** The characters a legend has not used, for a new entry to take one. */
export function freeChars(tiles: readonly TileSpec[]): readonly string[] {
  const taken = new Set(tiles.map((one) => one.char));
  const candidates = "#*=o^~+xX@%&$/\\|<>ABCDEFGHIJKLMNOPQRSTUVWZ0123456789";
  return [...candidates].filter((one) => !taken.has(one));
}
