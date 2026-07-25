/**
 * `stream` — a level built by drawing chunks, rather than drawn by hand.
 *
 * An endless scroller is not an endless level; it is a short vocabulary of
 * hand-made pieces played in an order nobody wrote down. Flappy Bird has one
 * chunk with a gap in it, 1942 has a handful of formations. Authoring the whole
 * course by hand would be both enormous and less interesting than the rule that
 * generates it.
 *
 * So composition happens **at compile time**, from the program's seed, and the
 * result is an ordinary {@link LevelFile}. Three things follow from that, and all
 * three are the reason it is done this way:
 *
 *   - The simulator, the collision model and the camera need no notion of
 *     streaming at all — they see a level, as before.
 *   - A console runtime needs none either: the composed tilemap is data in the
 *     ROM, not a generator the SM83 has to run identically.
 *   - The course is fixed for a given seed, so a trace is still a trace. A
 *     runtime-generated course would be reproducible only if every draw happened
 *     in the same order on every machine — a promise not worth making.
 *
 * "Endless" is therefore "long enough, and different every seed", which is what
 * the era's own scrollers did.
 */

import type { Diagnostic } from "../errors.js";
import { advance, pick } from "../rng.js";

import { EMPTY, type LevelFile, type TileSpec } from "./parse.js";

/** Which way the chunks are laid end to end. */
export type StreamAxis = "wide" | "tall";

/** One chunk offered to a stream, with the filename to name it in diagnostics. */
export interface StreamChunk {
  file: string;
  level: LevelFile;
}

/** What {@link streamLevel} produced, and the generator state it left behind. */
export interface StreamResult {
  level: LevelFile;
  /** Generator state after the draws, so the next `stream` continues the run. */
  state: number;
  diagnostics: readonly Diagnostic[];
}

/**
 * Draw `count` chunks and lay them end to end.
 *
 * Draws are uniform and independent — no "don't repeat the last one" rule, which
 * would be a design decision the language has no business making for a game.
 * Repetition is what a chunk vocabulary is for; if a game wants variety it adds
 * chunks.
 */
export function streamLevel(
  chunks: readonly StreamChunk[],
  count: number,
  axis: StreamAxis,
  state: number,
  line: number,
): StreamResult {
  const diagnostics: Diagnostic[] = [];
  const fail = (code: string, message: string, hint?: string): void => {
    diagnostics.push({
      severity: "error",
      code,
      message,
      line,
      ...(hint === undefined ? {} : { hint }),
    });
  };

  const merged = mergeLegends(chunks, fail);

  // Chunks butt up against one another, so the dimension they are *not* laid out
  // along has to agree — otherwise the join is a ragged edge rather than a seam.
  const span = (chunk: StreamChunk): number =>
    axis === "wide" ? chunk.level.height : chunk.level.width;
  const first = chunks[0];
  if (first) {
    const expected = span(first);
    for (const chunk of chunks) {
      if (span(chunk) === expected) continue;
      fail(
        "E_STREAM_MISMATCH",
        `'${chunk.file}' is ${span(chunk)} cells ${axis === "wide" ? "tall" : "wide"}; '${first.file}' is ${expected}`,
        `chunks laid ${axis === "wide" ? "side by side" : "end on end"} must agree on the other dimension`,
      );
    }
  }

  if (diagnostics.length > 0 || !first) {
    return { level: emptyLevel(merged), state, diagnostics };
  }

  const drawn: LevelFile[] = [];
  let next = state;
  for (let index = 0; index < count; index += 1) {
    next = advance(next);
    drawn.push((chunks[pick(next, chunks.length)] as StreamChunk).level);
  }

  return { level: join(drawn, merged, axis), state: next, diagnostics };
}

/**
 * One legend for the whole stream.
 *
 * A character has to mean the same thing in every chunk, because the composed
 * grid is read against a single legend — and because a `#` that is a wall in one
 * file and water in another is a bug in the chunks, not a feature.
 */
function mergeLegends(
  chunks: readonly StreamChunk[],
  fail: (code: string, message: string, hint?: string) => void,
): TileSpec[] {
  const byChar = new Map<string, TileSpec>();
  const owner = new Map<string, string>();

  for (const chunk of chunks) {
    for (const tile of chunk.level.tiles) {
      const seen = byChar.get(tile.char);
      if (!seen) {
        byChar.set(tile.char, tile);
        owner.set(tile.char, chunk.file);
        continue;
      }
      if (seen.name === tile.name && seen.solid === tile.solid && seen.art === tile.art) continue;
      fail(
        "E_STREAM_LEGEND",
        `'${tile.char}' is '${tile.name}' in ${chunk.file} but '${seen.name}' in ${owner.get(tile.char)}`,
        "chunks of one stream share a legend, so a character means the same thing in all of them",
      );
    }
  }

  return [...byChar.values()];
}

function join(levels: readonly LevelFile[], tiles: TileSpec[], axis: StreamAxis): LevelFile {
  if (axis === "tall") {
    const rows = levels.flatMap((level) => level.rows);
    const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    const padded = rows.map((row) => row.padEnd(width, EMPTY));
    return { tiles, rows: padded, width, height: padded.length, diagnostics: [] };
  }

  const height = levels[0]?.height ?? 0;
  const rows: string[] = [];
  for (let row = 0; row < height; row += 1) {
    rows.push(levels.map((level) => level.rows[row] ?? "").join(""));
  }
  return { tiles, rows, width: rows[0]?.length ?? 0, height, diagnostics: [] };
}

function emptyLevel(tiles: TileSpec[]): LevelFile {
  return { tiles, rows: [], width: 0, height: 0, diagnostics: [] };
}
