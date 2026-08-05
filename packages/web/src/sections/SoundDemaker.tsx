/**
 * The sound demaker: any recording becomes an effect a 1989 chip can make.
 *
 * The same four panes as the music section, and the same rule about where the
 * decisions live — everything comes back from `worker/audio.worker.ts`, and this
 * file decides nothing about sound. What differs is what there is to see. An
 * effect is short and percussive, so the interesting comparison is *shape*: the
 * pane draws the source's envelope and the chip's own output measured the same
 * way, which is the quantity the fitting loop was optimising (doc 18 §Stage 3).
 *
 * And the A/B is real here, unlike the music section's: the source is a recording
 * rather than a score, so there is something to play against the result. Both
 * sides came through `@demake/audio` — its WAV decoder and its chip models — so
 * the comparison is between two things the engine produced, never between our
 * output and the browser's idea of the input.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { AudioInputPane } from "../components/AudioInputPane.js";
import { AudioListenPane } from "../components/AudioListenPane.js";
import { AudioScoreboard } from "../components/AudioScoreboard.js";
import { CommandLine } from "../components/CommandLine.js";
import {
  DEFAULT_SAMPLE_RATE,
  DEFAULT_SFX,
  romCommand,
  sfxCommand,
  stemOf,
  toRenderOptions,
  wavCommand,
} from "../lib/audio-options.js";
import { filesOfKind } from "../lib/project.js";
import { fileHash } from "../lib/route.js";
import type { EditorProps } from "../site.js";
import { toPlayable } from "../lib/audio-player.js";
import { createAudioEngine } from "../worker/audio-client.js";
import { EngineError } from "../worker/client.js";
import type { AudioConsoleInfo, SfxOptionsUi, SfxPayload } from "../worker/audio-protocol.js";

const DEBOUNCE_MS = 200;

export function SoundDemaker({ project, path }: EditorProps) {
  const engine = useMemo(() => createAudioEngine(), []);
  const [consoleList, setConsoleList] = useState<AudioConsoleInfo[]>([]);
  const [options, setOptions] = useState<SfxOptionsUi>(() => ({ ...DEFAULT_SFX }));
  const [source, setSource] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [result, setResult] = useState<SfxPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; hint?: string } | null>(null);
  const runId = useRef(0);
  const previewRate = useRef(DEFAULT_SAMPLE_RATE);

  useEffect(() => {
    void engine.consoles().then(setConsoleList);
  }, [engine]);

  // The open project file is the input (doc 19 §The shell), and with none named
  // the project's first effect — a sound page with nothing in it has nothing to say.
  useEffect(() => {
    const wanted = path ?? filesOfKind(project, "sound")[0];
    if (wanted === undefined) return;
    const bytes = project.files.get(wanted)?.bytes;
    if (bytes) setSource({ name: wanted, bytes });
  }, [project, path]);

  const convert = useCallback(
    async (input: { name: string; bytes: Uint8Array }, current: SfxOptionsUi) => {
      const id = ++runId.current;
      setBusy(true);
      setError(null);
      try {
        const payload = await engine.sfx(input.bytes, current, previewRate.current);
        if (id !== runId.current) return;
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
        if (id === runId.current) setBusy(false);
      }
    },
    [engine],
  );

  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(() => void convert(source, options), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [source, options, convert]);

  const set = <K extends keyof SfxOptionsUi>(key: K, value: SfxOptionsUi[K]): void =>
    setOptions((previous) => ({ ...previous, [key]: value }));

  const active = consoleList.find((entry) => entry.id === options.console) ?? null;
  const stem = stemOf(source?.name ?? "effect.wav");
  const command = sfxCommand(options, source?.name ?? "effect.wav");
  const channel = active?.channels.find((entry) => entry.id === result?.placement.channelId);

  return (
    <main class="audio-layout">
      <AudioInputPane
        accept=".wav,audio/wav,audio/x-wav"
        prompt="Drop a WAV file here, or pick one."
        demos={filesOfKind(project, "sound").map((one) => ({ name: one, note: one }))}
        onPick={(one) => {
          location.hash = fileHash(one);
        }}
        demoLabel="Load effect"
        sourceName={source?.name ?? null}
        onSource={(name, bytes) => {
          // A pinned gesture belongs to the sound it was pinned for: the class
          // gate decides which families are eligible, so `sweep-down` on a swept
          // recording is simply not on the menu for a noisy one. Carrying it
          // across would answer a new file with an error about the old one.
          setOptions((previous) => ({ ...previous, strategy: "" }));
          setSource({ name, bytes });
        }}
      >
        {result ? (
          <dl class="facts" data-testid="sound-facts">
            <div>
              <dt>Class</dt>
              <dd data-testid="sound-class">{result.soundClass}</dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>{result.features.durationSeconds.toFixed(2)} s</dd>
            </div>
            <div>
              <dt>Attack</dt>
              <dd>{(result.features.attackSeconds * 1000).toFixed(0)} ms</dd>
            </div>
            <div>
              <dt>Pitch</dt>
              <dd>
                {result.features.meanF0 > 0
                  ? `${result.features.meanF0.toFixed(0)} Hz`
                  : "unvoiced"}
                {result.features.meanF0 > 0 && result.features.voicedFraction < 0.9 ? (
                  <span class="muted-note">
                    {" "}
                    · {(result.features.voicedFraction * 100).toFixed(0)}% voiced
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>
        ) : null}
        <p class="hint">
          The class decides which gesture families are even eligible (doc 18 §The class gate) — a
          noisy source is never fitted with a chime.
        </p>
      </AudioInputPane>

      <section class="pane controls-pane" aria-labelledby="sound-controls-heading">
        <h2 id="sound-controls-heading">Console &amp; options</h2>

        <label class="field">
          <span>Console</span>
          <select
            value={options.console}
            data-testid="console-select"
            onChange={(event) => set("console", (event.currentTarget as HTMLSelectElement).value)}
          >
            {consoleList.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        {active ? (
          <p class="console-summary" data-testid="console-summary">
            {active.summary}
          </p>
        ) : null}

        <label class="field">
          <span>Gesture</span>
          <select
            value={options.strategy}
            data-testid="strategy-select"
            onChange={(event) => set("strategy", (event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">auto — run the tournament</option>
            {(result?.tournament.candidates ?? []).map((candidate) => (
              <option key={candidate.id} value={candidate.id} title={candidate.summary}>
                {candidate.id}
              </option>
            ))}
          </select>
        </label>

        <label class="field">
          <span>Length budget (seconds)</span>
          <input
            type="number"
            min="0.1"
            max="10"
            step="0.1"
            value={options.maxLength}
            data-testid="max-length"
            onInput={(event) => set("maxLength", (event.currentTarget as HTMLInputElement).value)}
          />
        </label>

        <fieldset class="field effort">
          <legend>Effort</legend>
          {(["fast", "default", "max"] as const).map((value) => (
            <label key={value} class="radio">
              <input
                type="radio"
                name="sfx-effort"
                value={value}
                checked={options.effort === value}
                onChange={() => set("effort", value)}
              />
              <span>{value}</span>
            </label>
          ))}
        </fieldset>

        <label class="field">
          <span>Title (stored in the file)</span>
          <input
            type="text"
            placeholder={stem}
            value={options.title}
            onInput={(event) => set("title", (event.currentTarget as HTMLInputElement).value)}
          />
        </label>

        <fieldset class="field">
          <legend>Render</legend>
          <div class="field-row">
            <label class="field">
              <span>Output stage</span>
              <select
                value={options.outputStage}
                onChange={(event) =>
                  set(
                    "outputStage",
                    (event.currentTarget as HTMLSelectElement).value as "raw" | "board",
                  )
                }
              >
                <option value="raw">raw chip</option>
                <option value="board">the console&rsquo;s analog stage</option>
              </select>
            </label>
            <label class="field">
              <span>Sample rate</span>
              <select
                value={options.sampleRate}
                onChange={(event) =>
                  set("sampleRate", (event.currentTarget as HTMLSelectElement).value)
                }
              >
                {["48000", "44100", "96000"].map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} Hz
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        <button type="button" class="link" onClick={() => setOptions({ ...DEFAULT_SFX })}>
          Reset all options
        </button>

        <CommandLine command={command} />
      </section>

      <div class="audio-results">
        <section class="pane" aria-labelledby="fit-heading">
          <h2 id="fit-heading">The fit</h2>

          {busy ? (
            <p class="status" role="status" data-testid="status">
              Fitting…
            </p>
          ) : null}
          {error ? (
            <p class="error" role="alert" data-testid="error">
              <strong>{error.code}</strong> {error.message}
              {error.hint ? <span class="hint"> {error.hint}</span> : null}
            </p>
          ) : null}

          {result ? (
            <>
              <EnvelopeTrace
                source={result.envelopes.source}
                fitted={result.envelopes.fitted}
                frameRate={result.envelopes.frameRate}
              />
              <p class="hint">
                The source&rsquo;s loudness over time, and the chip&rsquo;s — measured the same way,
                because that shape is what the fitting loop was chasing. Every candidate was
                rendered <em>through the chip model</em> and scored against the recording, so
                nothing here could have been proposed that the hardware would refuse.
              </p>

              <dl class="facts" data-testid="fit-facts">
                <div>
                  <dt>Channel</dt>
                  <dd title={channel?.summary}>{result.placement.channelId}</dd>
                </div>
                <div>
                  <dt>Priority</dt>
                  <dd>{result.placement.priority}</dd>
                </div>
                <div>
                  <dt>Falls back to</dt>
                  <dd>{result.placement.prefers.join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt>Driver</dt>
                  <dd>
                    {result.script.timing.source} at {result.script.rateHz.toFixed(0)} Hz
                  </dd>
                </div>
                <div>
                  <dt>Writes</dt>
                  <dd>
                    {result.script.budgets.writes}
                    <span class="muted-note">
                      {" "}
                      · peak {result.script.budgets.peakWritesPerTick}/
                      {result.script.budgets.writeBudget} a tick
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>{result.elapsedMs} ms</dd>
                </div>
              </dl>

              {result.diagnostics.length > 0 ? (
                <ul class="warnings" data-testid="diagnostics">
                  {result.diagnostics.map((diagnostic, index) => (
                    <li key={index}>
                      <strong>{diagnostic.code}</strong> {diagnostic.message}
                    </li>
                  ))}
                </ul>
              ) : null}

              <AudioScoreboard
                winner={result.tournament.winner}
                candidates={result.tournament.candidates}
                pinned={options.strategy}
                autoValue=""
                onPick={(strategy) => set("strategy", strategy)}
              />
            </>
          ) : busy ? null : (
            <p class="hint">Drop a WAV file in, or load one from the example library.</p>
          )}
        </section>

        <AudioListenPane
          engine={engine}
          token={result?.token ?? null}
          pcm={result ? toPlayable(result.pcm) : null}
          source={result ? toPlayable(result.sourcePcm) : null}
          vgm={result?.vgm ?? null}
          stem={stem}
          title={options.title === "" ? stem : options.title}
          seconds={result?.script.seconds ?? 0}
          hasRom={active?.hasRom === true}
          romReason={`there is no audio driver backend for ${
            active?.name ?? "this console"
          } yet — the WAV is exact for every console (doc 16 §The proof)`}
          render={toRenderOptions(options)}
          commands={{
            wav: wavCommand(options, source?.name ?? "effect.wav"),
            rom: romCommand(options.console, source?.name ?? "effect.wav", ".gb"),
          }}
          onDeviceRate={(rate) => {
            previewRate.current = rate;
          }}
        />
      </div>
    </main>
  );
}

/**
 * Two loudness curves on one time axis.
 *
 * Plain SVG polylines rather than a canvas: it is a dozen elements, it scales
 * with the pane, and it stays legible in both themes without anything having to
 * redraw it. Both curves are peak-normalized by the analysis that produced them,
 * so the comparison is of *shape* — which is the thing a chip can and cannot
 * reproduce.
 */
function EnvelopeTrace({
  source,
  fitted,
  frameRate,
}: {
  source: readonly number[];
  fitted: readonly number[];
  frameRate: number;
}) {
  const frames = Math.max(source.length, fitted.length, 2);
  const points = (values: readonly number[]): string =>
    values
      .map((value, index) => `${((index / (frames - 1)) * 100).toFixed(2)},${(1 - value) * 100}`)
      .join(" ");

  return (
    <figure class="envelope-figure">
      <svg
        class="envelope"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label="The recording's loudness over time, and the chip's"
        data-testid="envelope"
      >
        <polyline class="envelope-source" points={points(source)} />
        <polyline class="envelope-fitted" points={points(fitted)} />
      </svg>
      <figcaption class="hint">
        <span class="envelope-key envelope-key-source" aria-hidden="true" /> the recording ·{" "}
        <span class="envelope-key envelope-key-fitted" aria-hidden="true" /> the chip · over{" "}
        {(frames / frameRate).toFixed(2)} s
      </figcaption>
    </figure>
  );
}
