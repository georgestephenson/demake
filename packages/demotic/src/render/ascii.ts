/**
 * A cell-grid text renderer.
 *
 * Not the real preview — that draws sprites to a canvas — but the same view of
 * the same state, which makes it useful in two places the canvas cannot reach:
 * a terminal demo, and test assertions that read as a picture rather than as a
 * list of coordinates.
 *
 * It renders the *cell* grid, so what it shows is the playfield at the
 * granularity the language actually thinks in. A Game Boy frame is 20×18
 * characters here; a Mega Drive frame is 40×28.
 *
 * It draws the *view*, not the level: object coordinates are level coordinates,
 * so everything is offset by the camera. That is the whole of what scrolling
 * costs a renderer, which is the point — the simulation never knew.
 */

import { floorToInt, toNumber } from "../fixed.js";
import { tileAt } from "../level/parse.js";
import type { EntityState } from "../sim.js";
import type { Sim } from "../sim.js";

/** Options for {@link renderAscii}. */
export interface AsciiOptions {
  /** Draw a border around the playfield. Default `true`. */
  border?: boolean;
  /** Character for empty cells. Default `.`. */
  empty?: string;
}

/** Glyph for an entity: first letter of its name, or a digit for numbers. */
function glyphFor(entity: EntityState): string {
  return (entity.name[0] ?? "?").toUpperCase();
}

/**
 * Render the running scene as a grid of characters.
 *
 * `number` and `text` objects are drawn as their contents, left-aligned from
 * their cell; everything else fills the cells its bounding box covers.
 */
export function renderAscii(sim: Sim, options: AsciiOptions = {}): string {
  const { border = true, empty = "." } = options;
  const { screenWidth, screenHeight } = sim.program.profile;

  const grid: string[][] = Array.from({ length: screenHeight }, () =>
    Array.from({ length: screenWidth }, () => empty),
  );

  const viewX = floorToInt(sim.camera.x);
  const viewY = floorToInt(sim.camera.y);

  const put = (x: number, y: number, char: string): void => {
    const column = x - viewX;
    const row = y - viewY;
    if (row < 0 || row >= screenHeight || column < 0 || column >= screenWidth) return;
    (grid[row] as string[])[column] = char;
  };

  // Tiles first, so an object standing on a ledge is drawn over it.
  const level = sim.level;
  if (level) {
    for (let row = 0; row < screenHeight; row += 1) {
      for (let column = 0; column < screenWidth; column += 1) {
        const tile = tileAt(level, viewX + column, viewY + row);
        if (tile) put(viewX + column, viewY + row, tile.name[0] as string);
      }
    }
  }

  for (const entity of sim.entities()) {
    if ((entity.numbers["visible"] ?? 0) === 0) continue;

    const x = floorToInt(entity.numbers["x"] ?? 0);
    const y = floorToInt(entity.numbers["y"] ?? 0);

    if (entity.className === "number" || entity.className === "text") {
      const text =
        entity.className === "number"
          ? String(Math.trunc(toNumber(entity.numbers["value"] ?? 0)))
          : (entity.strings["text"] ?? "");
      for (let i = 0; i < text.length; i += 1) put(x + i, y, text[i] as string);
      continue;
    }

    const width = Math.max(1, Math.ceil(toNumber(entity.numbers["width"] ?? 0)));
    const height = Math.max(1, Math.ceil(toNumber(entity.numbers["height"] ?? 0)));
    const glyph = glyphFor(entity);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) put(x + column, y + row, glyph);
    }
  }

  const rows = grid.map((row) => row.join(""));
  if (!border) return rows.join("\n");

  const rule = `+${"-".repeat(screenWidth)}+`;
  return [rule, ...rows.map((row) => `|${row}|`), rule].join("\n");
}
