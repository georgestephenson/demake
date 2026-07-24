/**
 * Preview pane (doc 07 §UX 3): the result at integer zoom next to the source,
 * optionally through the console's DAC model and pixel aspect ratio; the fitted
 * palette strip; the fit/tile-budget stats; the tournament scoreboard (which
 * doubles as a strategy picker); and the export bar.
 */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { download } from "../lib/download.js";
import type { SourceImage } from "../app.js";
import type { EngineClient } from "../worker/client.js";
import type { ConsoleInfo, PrepOptionsUi, PrepPayload } from "../worker/protocol.js";

interface Props {
  source: SourceImage | null;
  result: PrepPayload | null;
  console: ConsoleInfo | null;
  options: PrepOptionsUi;
  busy: boolean;
  progress: { stage: string; fraction: number } | null;
  error: { code: string; message: string; hint?: string } | null;
  engine: EngineClient;
  onStrategy: (strategy: string) => void;
}

const ZOOMS = [1, 2, 3, 4, 6, 8];

export function PreviewPane({
  source,
  result,
  console: consoleInfo,
  options,
  busy,
  progress,
  error,
  engine,
  onStrategy,
}: Props) {
  const [zoom, setZoom] = useState(2);
  const [showDac, setShowDac] = useState(false);
  const [parCorrect, setParCorrect] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const surface = result ? (showDac ? result.dac : result.raw) : null;

  // Draw the converted image at 1:1; CSS scales it with nearest-neighbor, so the
  // zoom stays crisp and integer (doc 07 §Stack: image-rendering: pixelated).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !surface) return;
    canvas.width = surface.width;
    canvas.height = surface.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(surface.width, surface.height);
    image.data.set(new Uint8ClampedArray(surface.data));
    ctx.putImageData(image, 0, 0);
  }, [surface]);

  const par = consoleInfo?.pixelAspect ?? [1, 1];
  const widthScale = parCorrect ? (par[0] ?? 1) / (par[1] ?? 1) : 1;
  const stem = useMemo(() => (source?.name ?? "image").replace(/\.[^.]+$/, ""), [source]);

  const exportCode = async (format: "asm" | "c" | "bin"): Promise<void> => {
    if (!source) return;
    setExporting(format);
    try {
      const artifacts = await engine.gen(source.bytes, options, format, stem);
      for (const artifact of artifacts) download(artifact.name, new Uint8Array(artifact.bytes));
    } finally {
      setExporting(null);
    }
  };

  const canGen = consoleInfo?.hasCodegen === true;

  return (
    <section class="pane preview-pane" aria-labelledby="preview-heading">
      <h2 id="preview-heading">Result</h2>

      <div class="preview-toolbar">
        <label class="field inline">
          <span>Zoom</span>
          <select
            value={String(zoom)}
            onChange={(e) => setZoom(Number((e.currentTarget as HTMLSelectElement).value))}
          >
            {ZOOMS.map((z) => (
              <option key={z} value={String(z)}>
                {z}×
              </option>
            ))}
          </select>
        </label>
        <label class="check inline">
          <input
            type="checkbox"
            checked={showDac}
            data-testid="dac-toggle"
            onChange={(e) => setShowDac((e.currentTarget as HTMLInputElement).checked)}
          />
          <span>Hardware screen colors</span>
        </label>
        <label class="check inline">
          <input
            type="checkbox"
            checked={parCorrect}
            onChange={(e) => setParCorrect((e.currentTarget as HTMLInputElement).checked)}
          />
          <span>
            Pixel aspect {par[0]}:{par[1]}
          </span>
        </label>
      </div>

      {busy && (
        <p class="status" role="status" data-testid="status">
          Converting
          {progress ? ` — ${progress.stage} ${Math.round(progress.fraction * 100)}%` : "…"}
        </p>
      )}

      {error && (
        <p class="error" role="alert" data-testid="error">
          <strong>{error.code}</strong> {error.message}
          {error.hint ? <span class="hint"> {error.hint}</span> : null}
        </p>
      )}

      <div class="compare">
        <figure>
          <figcaption>Source</figcaption>
          {source ? <img src={source.url} alt="source" /> : <div class="placeholder" />}
        </figure>
        <figure>
          <figcaption>
            {consoleInfo ? consoleInfo.name : "Result"}
            {result ? ` · ${result.raw.width}×${result.raw.height}` : ""}
          </figcaption>
          <canvas
            ref={canvasRef}
            data-testid="result-canvas"
            class="pixelated"
            style={{
              width: surface ? `${surface.width * zoom * widthScale}px` : undefined,
              height: surface ? `${surface.height * zoom}px` : undefined,
            }}
          />
        </figure>
      </div>

      {result && (
        <>
          <div class="palettes" data-testid="palette-strip">
            {result.palettes.map((palette, i) => (
              <div key={i} class="palette" title={`sub-palette ${i}`}>
                {palette.colors.map((color, j) => (
                  <span key={j} class="swatch" style={{ background: color }} title={color} />
                ))}
              </div>
            ))}
          </div>

          <dl class="facts stats" data-testid="stats">
            <div>
              <dt>Mean ΔE</dt>
              <dd>{result.stats.meanDeltaE.toFixed(2)}</dd>
            </div>
            <div>
              <dt>p95 ΔE</dt>
              <dd>{result.stats.p95DeltaE.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Unique tiles</dt>
              <dd>
                {result.stats.uniqueTiles}
                {result.stats.tileBudget !== null ? ` / ${result.stats.tileBudget}` : ""}
              </dd>
            </div>
            <div>
              <dt>Palette pressure</dt>
              <dd>{result.stats.palettePressure.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{result.elapsedMs} ms</dd>
            </div>
          </dl>

          {result.warnings.length > 0 && (
            <ul class="warnings" data-testid="warnings">
              {result.warnings.map((w) => (
                <li key={w.code}>
                  <strong>{w.code}</strong> {w.message}
                </li>
              ))}
            </ul>
          )}

          <details class="scoreboard" open>
            <summary>
              Tournament — <strong>{result.tournament.winner}</strong> won
            </summary>
            <table data-testid="scoreboard">
              <thead>
                <tr>
                  <th scope="col">Strategy</th>
                  <th scope="col">Score</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {result.tournament.candidates.map((c) => (
                  <tr
                    key={c.strategy}
                    class={c.strategy === result.tournament.winner ? "winner" : undefined}
                  >
                    <td>{c.strategy}</td>
                    <td>
                      {c.disqualified ? (
                        <span title={c.disqualified.reason}>disqualified</span>
                      ) : (
                        c.aggregate.toFixed(3)
                      )}
                    </td>
                    <td>
                      <button type="button" class="link" onClick={() => onStrategy(c.strategy)}>
                        preview
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <div class="exports" data-testid="exports">
            <button
              type="button"
              onClick={() => download(`${stem}.${options.console}.png`, new Uint8Array(result.png))}
              data-testid="export-png"
            >
              PNG
            </button>
            <button
              type="button"
              onClick={() =>
                download(`${stem}.${options.console}.json`, new Uint8Array(result.manifest))
              }
            >
              Manifest
            </button>
            <button
              type="button"
              disabled={!canGen || exporting !== null}
              title={canGen ? undefined : "no codegen backend for this console yet"}
              onClick={() => void exportCode("asm")}
            >
              {exporting === "asm" ? "…" : "asm"}
            </button>
            <button
              type="button"
              disabled={!canGen || exporting !== null}
              title={canGen ? undefined : "no codegen backend for this console yet"}
              onClick={() => void exportCode("c")}
            >
              {exporting === "c" ? "…" : "C"}
            </button>
            <button
              type="button"
              disabled={!canGen || exporting !== null}
              title={canGen ? undefined : "no codegen backend for this console yet"}
              onClick={() => void exportCode("bin")}
            >
              {exporting === "bin" ? "…" : "bin"}
            </button>
            <button
              type="button"
              disabled
              title="ROM assembly needs the console's assembler; run the same command with the CLI: demake gen … --format rom"
            >
              ROM
            </button>
          </div>
        </>
      )}
    </section>
  );
}
