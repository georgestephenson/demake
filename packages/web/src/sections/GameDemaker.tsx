/**
 * The Demotic section: write a game once, watch it play on any console.
 *
 * The split this pane exists to show (doc 14 §1): the **simulation** is
 * constrained — 16.16 fixed point on a fixed logical tick, the same arithmetic a
 * console runtime has to reproduce — while the **rendering** is not. Art is
 * authored as SVG and drawn at whatever size the page happens to be. Tick
 * "console pixels" to see the same state on the target's real 8×8 grid, with
 * scanlines carrying more sprites than the hardware will draw shaded red.
 *
 * The simulator runs on the main thread rather than in the engine worker: a tick
 * is a few hundred integer operations on a handful of entities, so the round
 * trip would cost more than the work. Art conversion still goes to the worker.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import {
  DEFAULT_EXAMPLE,
  DEMO_ASSETS,
  DEMO_LEVELS,
  EXAMPLES,
  type Example,
} from "../lib/demo-game.js";
import {
  check,
  formatResults,
  getProfile,
  parseTests,
  profiles,
  runTests,
  Sim,
  tileAt,
  toNumber,
  type Diagnostic,
} from "@demake/demotic";

/** Keyboard → the portable button set (doc 14 §Buttons). */
const KEYS: Readonly<Record<string, string>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  KeyA: "left",
  KeyD: "right",
  KeyW: "up",
  KeyS: "down",
  KeyZ: "a",
  KeyX: "b",
  Enter: "start",
};

/** Colours for objects whose art has not loaded. */
const FALLBACK = ["#7fd1ff", "#ffd479", "#9dffb0", "#ff9ecb", "#c4b5ff"];

interface Loaded {
  image: HTMLImageElement;
  ready: boolean;
}

export function GameDemaker() {
  const [example, setExample] = useState<Example>(DEFAULT_EXAMPLE);
  const [source, setSource] = useState(DEFAULT_EXAMPLE.source);
  const [consoleId, setConsoleId] = useState("gb");
  const [constrain, setConstrain] = useState(false);
  const [status, setStatus] = useState("");
  const [testReport, setTestReport] = useState<string | null>(null);

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const sim = useRef<Sim | null>(null);
  const held = useRef(new Set<string>());
  const latched = useRef(new Set<string>());
  const assets = useRef(new Map<string, Loaded>());
  const offscreen = useRef<HTMLCanvasElement | null>(null);

  // Compilation is pure and fast; there is nothing to debounce or cancel.
  const { program, diagnostics } = useMemo(() => {
    try {
      return check(source, { profile: getProfile(consoleId), levels: DEMO_LEVELS });
    } catch (error) {
      return {
        diagnostics: [
          { severity: "error", code: "E_INTERNAL", message: String(error), line: 1 },
        ] as Diagnostic[],
      };
    }
  }, [source, consoleId]);

  // --- input ----------------------------------------------------------------

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const action = KEYS[event.code];
      if (!action || isTyping(event.target)) return;
      held.current.add(action);
      // A tap shorter than one tick would otherwise vanish between polls.
      latched.current.add(action);
      event.preventDefault();
    };
    const up = (event: KeyboardEvent) => {
      const action = KEYS[event.code];
      if (!action) return;
      held.current.delete(action);
    };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
  }, []);

  // --- simulation -----------------------------------------------------------

  useEffect(() => {
    if (!program) return;
    sim.current = new Sim(program);
    for (const name of program.assets) loadAsset(assets.current, name);
    const element = canvas.current;
    if (element) {
      element.width = program.profile.screenWidth * 32;
      element.height = program.profile.screenHeight * 32;
    }
  }, [program]);

  useEffect(() => {
    if (!program) return;
    let raf = 0;
    let last = performance.now();
    let accumulator = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const current = sim.current;
      if (!current) return;

      const step = 1000 / current.program.profile.fps;
      accumulator += Math.min(now - last, 250);
      last = now;

      let budget = 8;
      while (accumulator >= step && budget-- > 0) {
        const input: Record<string, boolean> = {};
        for (const action of held.current) input[action] = true;
        for (const action of latched.current) input[action] = true;
        latched.current.clear();
        current.step(input);
        accumulator -= step;
      }

      setStatus(draw(canvas.current, offscreen, current, constrain, assets.current));
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [program, constrain]);

  // Touch and keyboard feed the same two sets, so a rule cannot tell them apart
  // — which is the point: the pad is an input device, not a second code path.
  const press = useCallback((action: string) => {
    held.current.add(action);
    latched.current.add(action);
  }, []);
  const release = useCallback((action: string) => {
    held.current.delete(action);
  }, []);

  const restart = useCallback(() => {
    if (program) sim.current = new Sim(program);
  }, [program]);

  const loadExample = useCallback((id: string) => {
    const next = EXAMPLES.find((candidate) => candidate.id === id);
    if (!next) return;
    setExample(next);
    setSource(next.source);
    setTestReport(null);
  }, []);

  const runSuite = useCallback(() => {
    const file = parseTests(example.tests);
    const results = [];
    for (const profile of profiles) {
      try {
        const compiled = check(source, { profile, levels: DEMO_LEVELS });
        if (compiled.program) results.push(runTests(file, compiled.program));
      } catch {
        /* a console this game cannot target is reported by its own diagnostics */
      }
    }
    const total = results.reduce((sum, r) => sum + r.cases.length, 0);
    const failed = results.reduce((sum, r) => sum + r.cases.filter((c) => !c.passed).length, 0);
    setTestReport(
      `${total - failed}/${total} cases passed across ${results.length} consoles\n\n${formatResults(results)}`,
    );
  }, [source, example]);

  const errors = diagnostics.filter((d) => d.severity === "error");

  return (
    <main class="game-layout">
      <section class="pane">
        <h2>Play</h2>
        <div class="game-toolbar">
          <label class="field inline">
            <span>Game</span>
            <select
              data-testid="example-select"
              value={example.id}
              onChange={(e) => loadExample((e.target as HTMLSelectElement).value)}
            >
              {EXAMPLES.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <label class="field inline">
            <span>Console</span>
            <select
              data-testid="console-select"
              value={consoleId}
              onChange={(e) => setConsoleId((e.target as HTMLSelectElement).value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label class="check inline">
            <input
              type="checkbox"
              checked={constrain}
              onChange={(e) => setConstrain((e.target as HTMLInputElement).checked)}
            />
            <span>Console pixels</span>
          </label>
          <button type="button" onClick={restart}>
            Restart
          </button>
          <button type="button" onClick={runSuite}>
            Run tests
          </button>
        </div>

        <canvas
          ref={canvas}
          class="game-canvas"
          width={640}
          height={576}
          role="img"
          aria-label="The game, playing"
        />
        <p class="hint">
          <strong>{example.name}</strong> — {example.covers}
        </p>

        <TouchPad onPress={press} onRelease={release} />

        <p class="hint keyboard-hint">
          Move with <kbd>←</kbd> <kbd>→</kbd>, <kbd>Z</kbd> is A, <kbd>X</kbd> is B,{" "}
          <kbd>Enter</kbd> is Start.
        </p>
        <pre class="game-status">{status}</pre>

        <p class="hint">
          A real ROM is not buildable yet: Demotic compiles to program tables, and the per-console
          runtime that consumes them is still to come (doc 14 §Runtime model). When it lands the
          page will assemble nothing — it patches tables into a prebuilt runtime and plays the
          result here.
        </p>
      </section>

      <section class="pane">
        <h2>Game</h2>
        <textarea
          class="game-source"
          aria-label="Demotic game source"
          spellcheck={false}
          value={source}
          onInput={(e) => setSource((e.target as HTMLTextAreaElement).value)}
        />
        <div class="game-diagnostics">
          {diagnostics.length === 0 ? (
            <p class="hint">No problems.</p>
          ) : (
            diagnostics.map((d, i) => (
              <p key={i} class={d.severity === "error" ? "diag-error" : "diag-warning"}>
                <strong>{d.code}</strong> line {d.line}: {d.message}
                {d.hint ? <span class="diag-hint"> — {d.hint}</span> : null}
              </p>
            ))
          )}
        </div>
        {errors.length > 0 ? (
          <p class="hint">The game keeps running the last version that compiled.</p>
        ) : null}
        {testReport ? <pre class="game-status">{testReport}</pre> : null}
      </section>
    </main>
  );
}

/**
 * An on-screen pad, for the machines this is most fun on.
 *
 * The pad is the **abstract** button set — `left right up down a b start`, the
 * portable floor from doc 14 §Buttons — and never a particular console's
 * controller. It is identical for every console and every game, because that set
 * is the only thing a `.dmt` file can bind to: a game that ignores `up` simply
 * never reads it. Nothing here branches on the target.
 *
 * Shown only where the primary pointer is coarse — a phone or a tablet — because
 * a keyboard is strictly better when there is one. Pointer events rather than
 * touch events, so it works with a stylus and a mouse too, and every button
 * releases on `pointerleave` and `pointercancel` as well as `pointerup`: sliding
 * a thumb off the d-pad must not leave the paddle running forever.
 */
function TouchPad({
  onPress,
  onRelease,
}: {
  onPress: (action: string) => void;
  onRelease: (action: string) => void;
}) {
  // `face` is what is drawn; `label` is what a screen reader says. The d-pad
  // draws arrows because "Right" does not fit in a thumb-sized circle.
  const bind = (action: string, label: string, face: string, extraClass = "") => (
    <button
      type="button"
      class={`pad-button ${extraClass}`}
      aria-label={label}
      onPointerDown={(event) => {
        // Claim the pointer so a drag off the button still delivers its release,
        // and stop the browser turning the gesture into a scroll or a selection.
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        event.preventDefault();
        onPress(action);
      }}
      onPointerUp={() => onRelease(action)}
      onPointerLeave={() => onRelease(action)}
      onPointerCancel={() => onRelease(action)}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span aria-hidden="true">{face}</span>
    </button>
  );

  return (
    <div class="touch-pad" aria-label="On-screen controls">
      <div class="pad-dpad">
        {bind("up", "Up", "\u25B2", "pad-up")}
        {bind("left", "Left", "\u25C0", "pad-left")}
        {bind("right", "Right", "\u25B6", "pad-right")}
        {bind("down", "Down", "\u25BC", "pad-down")}
      </div>
      <div class="pad-face">
        {bind("start", "Start", "Start", "pad-start")}
        <div class="pad-ab">
          {bind("b", "B", "B", "pad-b")}
          {bind("a", "A", "A", "pad-a")}
        </div>
      </div>
    </div>
  );
}

/** Don't steal arrow keys from the editor. */
function isTyping(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === "TEXTAREA" || tag === "INPUT";
}

function loadAsset(cache: Map<string, Loaded>, name: string): void {
  if (cache.has(name)) return;
  const url = DEMO_ASSETS[name];
  if (!url) return;
  const image = new Image();
  const entry: Loaded = { image, ready: false };
  image.addEventListener("load", () => {
    entry.ready = true;
  });
  image.src = url;
  cache.set(name, entry);
}

/**
 * The background layer: the scene's level, one cell at a time.
 *
 * Only the cells the view covers are considered, so the cost is a screenful
 * however long the level is — which is exactly what the hardware does, and the
 * reason a 144-cell course is not 144 cells of work per frame.
 *
 * A tile with no art draws as a flat block. That is deliberate: a legend entry
 * exists to give a *name* to rules, and a game may well want a named tile that
 * is never seen.
 */
function drawTiles(
  target: CanvasRenderingContext2D,
  sim: Sim,
  unit: number,
  viewX: number,
  viewY: number,
  constrain: boolean,
  assets: Map<string, Loaded>,
): void {
  const level = sim.level;
  if (!level) return;

  const { screenWidth, screenHeight } = sim.program.profile;
  const firstColumn = Math.floor(viewX);
  const firstRow = Math.floor(viewY);

  for (let row = firstRow; row <= firstRow + screenHeight; row += 1) {
    for (let column = firstColumn; column <= firstColumn + screenWidth; column += 1) {
      const tile = tileAt(level, column, row);
      if (!tile) continue;

      let x = (column - viewX) * unit;
      let y = (row - viewY) * unit;
      if (constrain) {
        x = Math.floor(x);
        y = Math.floor(y);
      }

      const art = tile.art ? assets.get(tile.art) : undefined;
      if (art?.ready) {
        target.drawImage(art.image, x, y, unit, unit);
      } else {
        target.fillStyle = tile.solid ? "#3a4459" : "#232b3b";
        target.fillRect(x, y, unit, unit);
      }
    }
  }
}

/** Draw one frame; returns the status line. */
function draw(
  element: HTMLCanvasElement | null,
  offscreenRef: { current: HTMLCanvasElement | null },
  sim: Sim,
  constrain: boolean,
  assets: Map<string, Loaded>,
): string {
  if (!element) return "";
  const context = element.getContext("2d");
  if (!context) return "";

  const { screenWidth, screenHeight, cellSize } = sim.program.profile;
  const unit = constrain ? cellSize : element.width / screenWidth;
  const width = screenWidth * unit;
  const height = screenHeight * unit;

  let target = context;
  if (constrain) {
    if (!offscreenRef.current) offscreenRef.current = document.createElement("canvas");
    const buffer = offscreenRef.current;
    if (buffer.width !== width || buffer.height !== height) {
      buffer.width = width;
      buffer.height = height;
    }
    target = buffer.getContext("2d") as CanvasRenderingContext2D;
  }

  target.imageSmoothingEnabled = !constrain;
  target.fillStyle = "#05070c";
  target.fillRect(0, 0, width, height);

  // Everything below draws the *view*, not the level: object coordinates are
  // level coordinates, and subtracting the camera is all scrolling costs the
  // renderer. The simulation never knew there was a view.
  const viewX = toNumber(sim.camera.x);
  const viewY = toNumber(sim.camera.y);

  drawTiles(target, sim, unit, viewX, viewY, constrain, assets);

  const perLine = new Int32Array(Math.max(1, Math.round(height)));

  for (const [index, entity] of sim.entities().entries()) {
    if ((entity.numbers["visible"] ?? 0) === 0) continue;

    let x = (toNumber(entity.numbers["x"] ?? 0) - viewX) * unit;
    let y = (toNumber(entity.numbers["y"] ?? 0) - viewY) * unit;
    const w = Math.max(1, toNumber(entity.numbers["width"] ?? 0)) * unit;
    const h = Math.max(1, toNumber(entity.numbers["height"] ?? 0)) * unit;

    // Hardware puts sprites on whole pixels; the preview need not.
    if (constrain) {
      x = Math.floor(x);
      y = Math.floor(y);
    }

    if (entity.className === "number" || entity.className === "text") {
      const text =
        entity.className === "number"
          ? String(Math.trunc(toNumber(entity.numbers["value"] ?? 0)))
          : (entity.strings["text"] ?? "");
      target.fillStyle = "#e8ecf5";
      target.font = `${Math.round(unit * 0.9)}px ui-monospace, monospace`;
      target.textBaseline = "top";
      target.fillText(text, x, y + unit * 0.05);
      continue;
    }

    const asset = entity.strings["sprite"] ? assets.get(entity.strings["sprite"]) : undefined;
    if (asset?.ready) {
      target.drawImage(asset.image, x, y, w, h);
    } else {
      target.fillStyle = FALLBACK[index % FALLBACK.length] as string;
      target.fillRect(x, y, w, h);
    }

    const columns = Math.max(1, Math.ceil(toNumber(entity.numbers["width"] ?? 0)));
    for (let line = Math.max(0, Math.floor(y)); line < Math.min(perLine.length, y + h); line += 1) {
      perLine[line] = (perLine[line] as number) + columns;
    }
  }

  const limit = sim.program.profile.sprites.perLine;
  if (constrain) {
    // Sprites past the per-line limit simply do not draw on hardware; seeing the
    // band here is the difference between shipping and debugging.
    target.fillStyle = "rgba(255, 90, 90, 0.35)";
    for (let line = 0; line < perLine.length; line += 1) {
      if ((perLine[line] as number) > limit) target.fillRect(0, line, width, 1);
    }
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, element.width, element.height);
    context.drawImage(target.canvas, 0, 0, element.width, element.height);
  }

  const peak = perLine.length > 0 ? Math.max(...perLine) : 0;
  const runtime = sim.runtimeBudget;
  const { profile, budget } = sim.program;
  return [
    `${profile.name}  ${profile.screenWidth}x${profile.screenHeight} cells (${profile.rawWidth}x${profile.rawHeight} px)  ${profile.fps} Hz`,
    `scene ${sim.scene}  tick ${sim.tick}`,
    `sprites ${budget.peakSprites}/${budget.spriteLimit}   this frame ${peak}/${limit} per line   worst seen ${runtime.peakSpritesPerLine}${runtime.exceeded ? "  ** over limit **" : ""}`,
  ].join("\n");
}
