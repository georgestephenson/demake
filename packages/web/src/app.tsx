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
import { kindOf, shortestName } from "@demake/demotic";
import { DEMAKEFILE_OPTIONS, settingsFor, uiToDemakefile } from "./lib/art-settings.js";
import { DEMAKEFILE, resolveOne, setAssetOption } from "./lib/demakefile.js";
import { projectFiles } from "./lib/project.js";
import type { Project } from "./lib/project.js";
import type { EditorProps } from "./site.js";

/** The source image the user dropped, pasted, picked, or loaded as the demo. */
export interface SourceImage {
  name: string;
  bytes: Uint8Array;
  url: string;
  width: number;
  height: number;
}

const DEBOUNCE_MS = 180;

export function App({
  project,
  path,
  onProject,
}: Partial<EditorProps> & {
  /** Replace the project — how a changed option reaches the Demakefile. */
  onProject?: (next: Project) => void;
} = {}) {
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

  // --- the Demakefile (doc 19 §Options edit the Demakefile) -----------------
  //
  // With a project art file open, these controls stop being scratch settings and
  // become a view of the build file: what they show is what the cascade resolves
  // to, and changing one writes the block for *this* asset.
  const editing = project !== undefined && path !== undefined && kindOf(path) === "art";
  const target = options.console;

  // Seed the controls from the file whenever the open asset changes. Not on every
  // project change: an edit replaces the project object, and re-seeding then would
  // undo the very control that caused it.
  useEffect(() => {
    if (!editing) return;
    setOptions((current) => ({ ...current, ...settingsFor(project, path, target) }));
  }, [editing, project, path, target]);

  /**
   * Change one option, and write it where it belongs.
   *
   * A value equal to what the cascade would give anyway *clears* the line rather
   * than restating it, which is what keeps a file free of directives that change
   * nothing (doc 15's third round-trip property).
   */
  const change = useCallback(
    (next: PrepOptionsUi) => {
      setOptions(next);
      if (!editing || !onProject) return;
      let edited = project;
      for (const name of DEMAKEFILE_OPTIONS) {
        const written = uiToDemakefile(name, next);
        const inherited = uiToDemakefile(name, {
          ...next,
          ...settingsFor(project, path, target, true),
        });
        edited = setAssetOption(
          edited,
          path,
          "art",
          name,
          written === undefined || written === inherited ? undefined : written,
        );
      }
      if (edited !== project) onProject(edited);
    },
    [editing, onProject, project, path, target],
  );

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

  // The open project file *is* the input (doc 19 §The shell): picking `ball.svg`
  // in the explorer converts `ball.svg`. Dropping a file still works and still
  // wins, because a drop is a deliberate act on this pane — it just also lands in
  // the project, which is what the explorer then lists.
  useEffect(() => {
    if (!project || path === undefined) return;
    const bytes = project.files.get(path)?.bytes;
    if (!bytes) return;
    let live = true;
    void describeSource(path, bytes).then((described) => {
      if (live) setSource(described);
    });
    return () => {
      live = false;
    };
  }, [project, path]);

  const activeConsole = consoleList.find((c) => c.id === options.console) ?? null;

  return (
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
        onChange={change}
        onReset={() => setOptions({ ...DEFAULT_OPTIONS })}
        sourceName={source?.name ?? "image.png"}
        {...(editing
          ? {
              writing: {
                file: DEMAKEFILE,
                asset: shortestName(path, projectFiles(project)),
                inherited: DEMAKEFILE_OPTIONS.filter(
                  (name) => resolveOne(project, path, "art", target, name).from === "defaults",
                ),
              },
            }
          : {})}
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
