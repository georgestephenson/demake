/**
 * The level editor: a `.dmtl` as text, as a map, or both (doc 19 §The level
 * editor).
 *
 * `.dmtl` is a text format a model can edit, and that was the point (doc 14
 * §Levels) — but a person drawing a room wants to draw it. Neither view here is
 * the authoritative one: **the file is**. Both views edit the same string, the
 * map view goes through `lib/dmtl.ts` (which rewrites only the lines it changes),
 * and a level stays hand-editable whether or not this editor ever touched it.
 *
 * Two things this section gets from the project model and could not have had
 * before it. A tile's art is picked from the project's own pictures rather than
 * typed as a filename, and written back as the shortest name that identifies the
 * one chosen — the same string a `.dmt` would use. And the **console viewports**
 * are the project's declared targets, drawn over the grid, because a level is
 * authored in cells and the consoles do not agree on how many of them fit: a
 * feature 34 cells wide is one nobody on a Game Boy sees whole, and that is worth
 * finding out while drawing rather than after building seven cartridges.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import {
  EMPTY,
  parseDemakefile,
  parseLevel,
  profiles,
  resolveProject,
  resolveReference,
  shortestName,
  type ConsoleProfile,
  type TileSpec,
} from "@demake/demotic";

import { SourceEditor } from "../components/SourceEditor.js";
import { DEMAKEFILE } from "../lib/demakefile.js";
import {
  addLegend,
  cellAt,
  fillRect,
  floodFill,
  freeChars,
  gridWidth,
  joinLevel,
  removeLegend,
  resizeGrid,
  setCell,
  setLegend,
  splitLevel,
  type LevelText,
} from "../lib/dmtl.js";
import { filesOfKind, projectFiles, readText } from "../lib/project.js";
import { fileHash } from "../lib/route.js";
import { drawTileCell, loadAsset, type Loaded } from "../lib/tiles.js";
import type { EditorProps } from "../site.js";

/** How long the editor waits before handing the project what you typed. */
const SETTLE_MS = 400;

/** A cell's size on screen. The canvas scales down to the pane if it must. */
const UNIT = 16;

/** Which views are showing. */
type View = "text" | "map" | "both";

const VIEWS: readonly { id: View; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "text", label: "Text" },
  { id: "both", label: "Map and text" },
];

/** What a click on the grid does. */
type Tool = "pencil" | "rectangle" | "fill" | "erase" | "pick";

const TOOLS: readonly { id: Tool; label: string; hint: string }[] = [
  { id: "pencil", label: "Pencil", hint: "Paint one cell at a time" },
  { id: "rectangle", label: "Rectangle", hint: "Drag a filled rectangle" },
  { id: "fill", label: "Flood", hint: "Fill the region drawn with one character" },
  { id: "erase", label: "Erase", hint: "Paint the empty character" },
  { id: "pick", label: "Pick", hint: "Take the character under the pointer" },
];

interface Cell {
  row: number;
  column: number;
}

export function LevelEditor({ project, path, onEdit }: EditorProps) {
  const levels = filesOfKind(project, "level");
  // Which `.dmtl` is open. The explorer decides; with nothing named, the
  // project's first level, because a level section with no level in it has
  // nothing to say (doc 19 §The shell).
  const openPath = path ?? levels[0] ?? "";
  const [draft, setDraft] = useState(() => readText(project, openPath));
  const [view, setView] = useState<View>("both");
  const [tool, setTool] = useState<Tool>("pencil");
  const [pick, setPick] = useState("");
  const [drag, setDrag] = useState<{ from: Cell; to: Cell } | null>(null);
  const [overlay, setOverlay] = useState("targets");
  // Bumped when a picture finishes loading. The grid paints on demand rather
  // than every frame, so an image arriving afterwards has to say so.
  const [loaded, setLoaded] = useState(0);

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const assets = useRef(new Map<string, Loaded>());

  const level = useMemo(() => splitLevel(draft), [draft]);
  const parsed = useMemo(() => parseLevel(draft), [draft]);
  const width = Math.max(1, gridWidth(level));
  const height = level.rows.length;

  const art = useMemo(() => filesOfKind(project, "art"), [project]);
  const files = useMemo(() => projectFiles(project), [project]);

  // What is drawn where, with each tile's art *resolved*: a legend says
  // `rockwall.svg` and the project holds `art/rockwall.svg`, and the shortest
  // name that identifies a file is the whole point of the reference rule (doc 19
  // §The rule). Resolving here rather than in the drawing code is what lets the
  // editor draw a cell through the same function the game preview draws one with.
  const byChar = useMemo(() => {
    const map = new Map<string, TileSpec>();
    for (const tile of parsed.tiles) {
      const path =
        tile.art === undefined ? undefined : resolveReference(tile.art, "art", files).path;
      map.set(tile.char, path === undefined ? tile : { ...tile, art: path });
    }
    return map;
  }, [parsed, files]);

  // The character being painted with: whatever was picked, while it still exists
  // in the legend, else the first entry. A tool with nothing to draw is a tool
  // that does nothing when you click.
  const char = byChar.has(pick) ? pick : (parsed.tiles[0]?.char ?? EMPTY);

  // The rectangles drawn over the grid: the project's targets, or one console
  // chosen by hand. A project with no Demakefile declares no targets, so it falls
  // back to a single machine rather than to every machine at once — a dozen
  // overlapping rectangles say less than one.
  const targets = useMemo(() => {
    const plan = resolveProject(parseDemakefile(readText(project, DEMAKEFILE)), files);
    return plan.targets.map((one) => one.console);
  }, [project, files]);
  const chosen = overlay === "targets" && targets.length === 0 ? "gb" : overlay;
  const overlays = useMemo<readonly ConsoleProfile[]>(() => {
    const ids = chosen === "none" ? [] : chosen === "targets" ? targets : [chosen];
    return ids
      .map((id) => profiles.find((one) => one.id === id))
      .filter((one): one is ConsoleProfile => one !== undefined);
  }, [chosen, targets]);

  // Opening a different level replaces the draft outright.
  useEffect(() => {
    setDraft(readText(project, openPath));
    setPick("");
    // Keyed on the path alone: reacting to the project itself would undo every
    // keystroke, since an edit is what replaces the project.
  }, [openPath]);

  // Typing and painting reach the project once they have settled, so the
  // explorer, a build and a save all see what the editor shows.
  useEffect(() => {
    if (draft === readText(project, openPath)) return;
    const timer = setTimeout(() => onEdit(openPath, draft), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    for (const tile of byChar.values()) {
      if (tile.art) loadAsset(assets.current, project, tile.art, () => setLoaded((n) => n + 1));
    }
  }, [byChar, project]);

  const apply = useCallback((next: LevelText) => setDraft(joinLevel(next)), []);

  // --- the grid -------------------------------------------------------------

  useEffect(() => {
    paint(canvas.current, level, byChar, assets.current, drag, overlays, width, height);
    // `view` is in here because the canvas only exists while the map is on
    // screen: coming back from the text view mounts a fresh, blank one, and
    // nothing else about the level has changed to say so.
  }, [level, byChar, drag, overlays, width, height, loaded, view]);

  const cellFrom = useCallback(
    (event: PointerEvent): Cell | null => {
      const element = canvas.current;
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const column = Math.floor(((event.clientX - rect.left) / rect.width) * width);
      const row = Math.floor(((event.clientY - rect.top) / rect.height) * height);
      if (row < 0 || row >= height || column < 0 || column >= width) return null;
      return { row, column };
    },
    [width, height],
  );

  const paintAt = useCallback(
    (cell: Cell) => {
      if (tool === "pick") {
        setPick(cellAt(level, cell.row, cell.column));
        return;
      }
      if (tool === "fill") {
        apply(floodFill(level, cell.row, cell.column, char, width));
        return;
      }
      apply(setCell(level, cell.row, cell.column, tool === "erase" ? EMPTY : char));
    },
    [tool, level, char, width, apply],
  );

  const onDown = useCallback(
    (event: PointerEvent) => {
      const cell = cellFrom(event);
      if (!cell) return;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      event.preventDefault();
      if (tool === "rectangle") setDrag({ from: cell, to: cell });
      else paintAt(cell);
    },
    [cellFrom, tool, paintAt],
  );

  const onMove = useCallback(
    (event: PointerEvent) => {
      if (event.buttons === 0) return;
      const cell = cellFrom(event);
      if (!cell) return;
      if (tool === "rectangle") setDrag((current) => (current ? { ...current, to: cell } : null));
      else if (tool === "pencil" || tool === "erase") paintAt(cell);
    },
    [cellFrom, tool, paintAt],
  );

  // Only the rectangle tool holds a drag, so a released one always paints the
  // selected character. The eraser paints as the pointer moves, like the pencil.
  const onUp = useCallback(() => {
    if (drag) apply(fillRect(level, drag.from, drag.to, char));
    setDrag(null);
  }, [drag, level, char, apply]);

  // --- the legend -----------------------------------------------------------

  const countOf = useCallback(
    (one: string) =>
      level.rows.reduce((sum, row) => sum + [...row].filter((cell) => cell === one).length, 0),
    [level],
  );

  /** Rewrite one legend entry. `art: null` clears it; leaving it out keeps it. */
  const editTile = (
    tile: TileSpec,
    change: { name?: string; solid?: boolean; art?: string | null },
  ) => {
    const art = change.art === undefined ? tile.art : (change.art ?? undefined);
    apply(
      setLegend(level, tile.line, {
        char: tile.char,
        name: change.name ?? tile.name,
        solid: change.solid ?? tile.solid,
        ...(art === undefined ? {} : { art }),
      }),
    );
  };

  const errors = parsed.diagnostics;
  const showMap = view !== "text";
  const showText = view !== "map";

  if (openPath === "") {
    return (
      <main>
        <section class="pane">
          <h2>Levels</h2>
          <p class="hint">
            This project has no <code>.dmtl</code> files. A level is a legend and a grid drawn in
            characters; put one in <code>levels/</code> and a scene can <code>load</code> it.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main class="game-layout">
      <section class="pane">
        <h2>Level</h2>
        <div class="game-toolbar">
          <label class="field inline">
            <span>File</span>
            <select
              data-testid="level-select"
              value={openPath}
              onChange={(e) => {
                location.hash = fileHash((e.currentTarget as HTMLSelectElement).value);
              }}
            >
              {levels.map((one) => (
                <option key={one} value={one}>
                  {one.slice(one.lastIndexOf("/") + 1)}
                </option>
              ))}
            </select>
          </label>
          <label class="field inline">
            <span>View</span>
            <select
              data-testid="level-view"
              value={view}
              onChange={(e) => setView((e.currentTarget as HTMLSelectElement).value as View)}
            >
              {VIEWS.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.label}
                </option>
              ))}
            </select>
          </label>
          <label class="field inline">
            <span>Viewport</span>
            <select
              data-testid="level-overlay"
              value={chosen}
              onChange={(e) => setOverlay((e.currentTarget as HTMLSelectElement).value)}
            >
              {targets.length > 0 ? <option value="targets">Project targets</option> : null}
              <option value="none">None</option>
              {profiles.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {showMap ? (
          <>
            <div class="game-toolbar level-tools">
              {TOOLS.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  class={`level-tool${one.id === tool ? " active" : ""}`}
                  title={one.hint}
                  aria-pressed={one.id === tool}
                  onClick={() => setTool(one.id)}
                >
                  {one.label}
                </button>
              ))}
              <label class="field inline">
                <span>Width</span>
                <input
                  type="number"
                  min={1}
                  value={width}
                  onChange={(e) =>
                    apply(resizeGrid(level, Number((e.target as HTMLInputElement).value), height))
                  }
                />
              </label>
              <label class="field inline">
                <span>Height</span>
                <input
                  type="number"
                  min={1}
                  value={height}
                  onChange={(e) =>
                    apply(resizeGrid(level, width, Number((e.target as HTMLInputElement).value)))
                  }
                />
              </label>
            </div>

            <div class="level-grid-wrap">
              <canvas
                ref={canvas}
                class="level-grid"
                data-testid="level-grid"
                role="img"
                aria-label={`The level, ${String(width)} by ${String(height)} cells`}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
              />
            </div>
            <p class="hint">
              {width} × {height} cells
              {overlays.length > 0
                ? ` · viewport ${overlays.map((one) => `${one.name} ${String(one.screenWidth)}×${String(one.screenHeight)}`).join(", ")}`
                : ""}
            </p>
          </>
        ) : null}

        {showText ? <SourceEditor value={draft} onInput={setDraft} label="Level source" /> : null}

        <div class="game-diagnostics">
          {errors.length === 0 ? (
            <p class="hint">No problems.</p>
          ) : (
            errors.map((one, index) => (
              <p key={index} class={one.severity === "error" ? "diag-error" : "diag-warning"}>
                <strong>{one.code}</strong> line {one.line}: {one.message}
                {one.hint ? <span class="diag-hint"> — {one.hint}</span> : null}
              </p>
            ))
          )}
        </div>
      </section>

      <section class="pane">
        <h2>Legend</h2>
        <p class="hint">
          A tile&rsquo;s name is what rules collide with: <code>when player touches spikes</code>{" "}
          reads as a sentence because the legend gave that character a name.
        </p>
        <ul class="legend-list" data-testid="legend">
          {parsed.tiles.map((tile) => (
            <li
              key={tile.line}
              class={`legend-row${tile.char === char ? " selected" : ""}`}
              onClick={() => setPick(tile.char)}
            >
              <button
                type="button"
                class="legend-char"
                aria-pressed={tile.char === char}
                aria-label={`Paint with ${tile.name}`}
                onClick={() => setPick(tile.char)}
              >
                {tile.char === " " ? "␣" : tile.char}
              </button>
              <input
                class="legend-name"
                value={tile.name}
                aria-label="Tile name"
                onChange={(e) => editTile(tile, { name: (e.target as HTMLInputElement).value })}
              />
              <label class="check inline">
                <input
                  type="checkbox"
                  checked={tile.solid}
                  onChange={(e) =>
                    editTile(tile, { solid: (e.target as HTMLInputElement).checked })
                  }
                />
                <span>solid</span>
              </label>
              <select
                class="legend-art"
                aria-label="Tile art"
                value={tile.art ?? ""}
                onChange={(e) => {
                  const value = (e.target as HTMLSelectElement).value;
                  editTile(tile, { art: value === "" ? null : value });
                }}
              >
                <option value="">no art</option>
                {/* Whatever the file already says, even if no such picture is in
                    the project: a dropdown that silently dropped a name would
                    rewrite the level on the next unrelated edit. */}
                {tile.art !== undefined &&
                !art.some((one) => shortestName(one, files) === tile.art) ? (
                  <option value={tile.art}>{tile.art}</option>
                ) : null}
                {art.map((one) => {
                  const name = shortestName(one, files);
                  return (
                    <option key={one} value={name}>
                      {name}
                    </option>
                  );
                })}
              </select>
              <span class="legend-count">{countOf(tile.char)} cells</span>
              <button
                type="button"
                class="legend-remove"
                aria-label={`Remove ${tile.name}`}
                title={`${String(countOf(tile.char))} cells use this character`}
                onClick={() => apply(removeLegend(level, tile.line))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => {
            const next = freeChars(parsed.tiles)[0];
            if (next === undefined) return;
            apply(
              addLegend(level, {
                char: next,
                name: `tile${String(parsed.tiles.length + 1)}`,
                solid: false,
              }),
            );
            setPick(next);
          }}
        >
          Add tile
        </button>
        <p class="hint">
          Removing an entry leaves the cells drawn with it as they were — the compiler reports them,
          which is a better answer than an editor silently erasing part of a level.
        </p>
      </section>
    </main>
  );
}

/**
 * Draw the grid.
 *
 * Cells go through `drawTileCell`, which is what the game section's preview
 * draws a scene's tiles with. A character with no legend entry is drawn as
 * itself on a hatched cell — visible, editable, and not quietly deleted
 * (doc 19 §The level editor).
 */
function paint(
  element: HTMLCanvasElement | null,
  level: LevelText,
  byChar: Map<string, TileSpec>,
  assets: Map<string, Loaded>,
  drag: { from: Cell; to: Cell } | null,
  overlays: readonly ConsoleProfile[],
  width: number,
  height: number,
): void {
  if (!element) return;
  const w = Math.max(1, width * UNIT);
  const h = Math.max(1, height * UNIT);
  if (element.width !== w) element.width = w;
  if (element.height !== h) element.height = h;
  const target = element.getContext("2d");
  if (!target) return;

  target.imageSmoothingEnabled = false;
  target.fillStyle = "#05070c";
  target.fillRect(0, 0, w, h);

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const cell = cellAt(level, row, column);
      if (cell === EMPTY) continue;
      const x = column * UNIT;
      const y = row * UNIT;
      const tile = byChar.get(cell);
      if (tile) {
        drawTileCell(target, tile, assets, x, y, UNIT);
        continue;
      }
      target.fillStyle = "#3d2130";
      target.fillRect(x, y, UNIT, UNIT);
      target.fillStyle = "#ffb4c8";
      target.font = `${String(Math.round(UNIT * 0.8))}px ui-monospace, monospace`;
      target.textAlign = "center";
      target.textBaseline = "middle";
      target.fillText(cell, x + UNIT / 2, y + UNIT / 2);
    }
  }

  target.strokeStyle = "rgba(255, 255, 255, 0.07)";
  target.lineWidth = 1;
  target.beginPath();
  for (let column = 1; column < width; column += 1) {
    target.moveTo(column * UNIT + 0.5, 0);
    target.lineTo(column * UNIT + 0.5, h);
  }
  for (let row = 1; row < height; row += 1) {
    target.moveTo(0, row * UNIT + 0.5);
    target.lineTo(w, row * UNIT + 0.5);
  }
  target.stroke();

  if (drag) {
    const x = Math.min(drag.from.column, drag.to.column) * UNIT;
    const y = Math.min(drag.from.row, drag.to.row) * UNIT;
    const dw = (Math.abs(drag.to.column - drag.from.column) + 1) * UNIT;
    const dh = (Math.abs(drag.to.row - drag.from.row) + 1) * UNIT;
    target.fillStyle = "rgba(127, 209, 255, 0.25)";
    target.fillRect(x, y, dw, dh);
  }

  // One rectangle per target, anchored at the level's top-left corner, which is
  // where a scene's camera starts.
  target.lineWidth = 2;
  target.font = `${String(Math.round(UNIT * 0.7))}px ui-monospace, monospace`;
  target.textAlign = "left";
  target.textBaseline = "top";
  for (const [index, profile] of overlays.entries()) {
    const colour = `hsl(${String((index * 67 + 20) % 360)} 90% 68%)`;
    const bottom = profile.screenHeight * UNIT;
    target.strokeStyle = colour;
    target.strokeRect(1, 1, profile.screenWidth * UNIT - 2, bottom - 2);
    // The label sits on a chip of its own, because it is drawn over the art and
    // a picture is whatever colour the picture is.
    const label = `${profile.name} ${String(profile.screenWidth)}×${String(profile.screenHeight)}`;
    const box = target.measureText(label).width + 8;
    target.fillStyle = "rgba(5, 7, 12, 0.85)";
    target.fillRect(2, bottom - UNIT - 2, box, UNIT);
    target.fillStyle = colour;
    target.fillText(label, 6, bottom - UNIT + 1);
  }
}
