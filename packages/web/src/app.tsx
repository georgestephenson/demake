/**
 * The app shell (doc 07 §UX specification): one screen, three panes — input,
 * controls, preview — over a single store.
 *
 * All conversion state lives here and flows down; the engine lives in a worker
 * and is spoken to only through {@link EngineClient}. Conversions are debounced
 * and superseded, so dragging a control never queues a backlog of runs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { ControlsPane } from "./components/ControlsPane.js";
import { InputPane } from "./components/InputPane.js";
import { PreviewPane } from "./components/PreviewPane.js";
import { DEFAULT_OPTIONS } from "./lib/options.js";
import { fromHash, toHash } from "./lib/permalink.js";
import { createEngine, EngineError } from "./worker/client.js";
import type { ConsoleInfo, PrepOptionsUi, PrepPayload } from "./worker/protocol.js";
import type { StrategyInfo } from "@demake/core";

/** The source image the user dropped, pasted, picked, or loaded as the demo. */
export interface SourceImage {
  name: string;
  bytes: Uint8Array;
  url: string;
  width: number;
  height: number;
}

const DEBOUNCE_MS = 180;

export function App() {
  const engine = useMemo(() => createEngine(), []);
  const [consoleList, setConsoleList] = useState<ConsoleInfo[]>([]);
  const [strategyList, setStrategyList] = useState<StrategyInfo[]>([]);
  const [options, setOptions] = useState<PrepOptionsUi>(() => fromHash(location.hash));
  const [source, setSource] = useState<SourceImage | null>(null);
  const [result, setResult] = useState<PrepPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ stage: string; fraction: number } | null>(null);
  const [error, setError] = useState<{ code: string; message: string; hint?: string } | null>(null);
  const runId = useRef(0);

  // Console list + per-console strategy portfolio come from the engine, so the
  // UI never carries a second copy of what a console can do.
  useEffect(() => {
    void engine.consoles().then(setConsoleList);
  }, [engine]);
  useEffect(() => {
    void engine.strategies(options.console).then(setStrategyList);
  }, [engine, options.console]);

  // Options (never the image) live in the URL hash: shareable settings.
  useEffect(() => {
    const hash = toHash(options);
    history.replaceState(null, "", hash === "" ? location.pathname + location.search : hash);
  }, [options]);

  const convert = useCallback(
    async (src: SourceImage, opts: PrepOptionsUi) => {
      const id = ++runId.current;
      setBusy(true);
      setError(null);
      try {
        const payload = await engine.prep(src.bytes, opts, (stage, fraction) => {
          if (id === runId.current) setProgress({ stage, fraction });
        });
        if (id !== runId.current) return; // superseded by a newer run
        setResult(payload);
      } catch (err) {
        if (id !== runId.current) return;
        setResult(null);
        setError(
          err instanceof EngineError
            ? { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }
            : { code: "E_INTERNAL", message: String(err) },
        );
      } finally {
        if (id === runId.current) {
          setBusy(false);
          setProgress(null);
        }
      }
    },
    [engine],
  );

  // Debounced re-conversion on any change to the source or the options.
  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(() => void convert(source, options), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [source, options, convert]);

  const loadDemo = useCallback(async () => {
    const png = await engine.demo();
    setSource(await describeSource("demo-scene.png", png));
  }, [engine]);

  const activeConsole = consoleList.find((c) => c.id === options.console) ?? null;

  return (
    <div class="layout">
      <header class="topbar">
        <h1>
          <span class="wordmark">demake</span>
          <span class="tagline">any image → hardware-compliant console art</span>
        </h1>
        <p class="privacy">
          Runs entirely in your browser. Nothing is uploaded — the engine is the same{" "}
          <code>@demake/core</code> the CLI uses.
        </p>
      </header>

      <main>
        <InputPane
          source={source}
          onSource={setSource}
          onDemo={() => void loadDemo()}
          profile={result?.decisions.profile ?? null}
        />
        <ControlsPane
          options={options}
          consoles={consoleList}
          strategies={strategyList}
          onChange={setOptions}
          onReset={() => setOptions({ ...DEFAULT_OPTIONS })}
          sourceName={source?.name ?? "image.png"}
        />
        <PreviewPane
          source={source}
          result={result}
          console={activeConsole}
          options={options}
          busy={busy}
          progress={progress}
          error={error}
          engine={engine}
          onStrategy={(strategy) => setOptions((prev) => ({ ...prev, strategy }))}
        />
      </main>

      <footer>
        <a href="https://github.com/georgestephenson/demake">source</a> ·{" "}
        <a href="https://github.com/georgestephenson/demake/tree/main/docs">design docs</a> · the
        same conversion is available as <code>npx demake</code>
      </footer>
    </div>
  );
}

/** Wrap raw image bytes in the metadata the panes display. */
export async function describeSource(name: string, bytes: Uint8Array): Promise<SourceImage> {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer]);
  const url = URL.createObjectURL(blob);
  const { width, height } = await measure(url);
  return { name, bytes, url, width, height };
}

function measure(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}
