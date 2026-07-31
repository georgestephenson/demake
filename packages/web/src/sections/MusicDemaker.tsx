/**
 * The music demaker: any track becomes chip music the hardware can play.
 *
 * Four panes over one `arrange` call (doc 07 §The audio sections): **Source** —
 * the file and what analysis made of it, with the classifier's roles editable
 * because a wrong role is a wrong arrangement; **Console & options** — every
 * `demake arrange` flag, with the equivalent command line underneath;
 * **Arrangement** — the channel plan as a piano roll, the timing report and the
 * budgets; and **Listen** — play it, and take the artifacts away.
 *
 * The engine is in a worker (`worker/audio.worker.ts`) and this file never
 * imports `@demake/audio` for anything but types: a page that decided anything
 * about music itself would be a second implementation of the demaker, which is
 * the failure doc 07 forbids for images and doc 14 forbids for art.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { AudioInputPane } from "../components/AudioInputPane.js";
import { AudioListenPane } from "../components/AudioListenPane.js";
import { AudioScoreboard } from "../components/AudioScoreboard.js";
import { ChannelPlan } from "../components/ChannelPlan.js";
import { CommandLine } from "../components/CommandLine.js";
import {
  arrangeCommand,
  DEFAULT_ARRANGE,
  DEFAULT_SAMPLE_RATE,
  romCommand,
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
import type {
  ArrangeOptionsUi,
  ArrangePayload,
  AudioConsoleInfo,
} from "../worker/audio-protocol.js";
import type { PartRole } from "@demake/audio";

const DEBOUNCE_MS = 200;

const ROLES: readonly PartRole[] = [
  "percussion",
  "bass",
  "lead",
  "harmony",
  "pad",
  "arp",
  "fx",
] as const;

export function MusicDemaker({ project, path }: EditorProps) {
  const engine = useMemo(() => createAudioEngine(), []);
  const [consoleList, setConsoleList] = useState<AudioConsoleInfo[]>([]);
  const [options, setOptions] = useState<ArrangeOptionsUi>(() => ({ ...DEFAULT_ARRANGE }));
  const [source, setSource] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [result, setResult] = useState<ArrangePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; hint?: string } | null>(null);
  const runId = useRef(0);
  // The rate the audio device turned out to want. It is a ref rather than state
  // because learning it must not re-run the arrangement — the schedule does not
  // depend on it, only the preview render does, and the Listen pane re-renders
  // on its own when the two disagree.
  const previewRate = useRef(DEFAULT_SAMPLE_RATE);

  useEffect(() => {
    void engine.consoles().then(setConsoleList);
  }, [engine]);

  // The open project file is the input (doc 19 §The shell), and with none named
  // the project's first track — a music page with nothing in it has nothing to say.
  useEffect(() => {
    const wanted = path ?? filesOfKind(project, "music")[0];
    if (wanted === undefined) return;
    const bytes = project.files.get(wanted)?.bytes;
    if (bytes) setSource({ name: wanted, bytes });
  }, [project, path]);

  const convert = useCallback(
    async (input: { name: string; bytes: Uint8Array }, current: ArrangeOptionsUi) => {
      const id = ++runId.current;
      setBusy(true);
      setError(null);
      try {
        const payload = await engine.arrange(input.bytes, current, previewRate.current);
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

  const set = <K extends keyof ArrangeOptionsUi>(key: K, value: ArrangeOptionsUi[K]): void =>
    setOptions((previous) => ({ ...previous, [key]: value }));

  const active = consoleList.find((entry) => entry.id === options.console) ?? null;
  const stem = stemOf(source?.name ?? "track.mid");
  const command = arrangeCommand(options, source?.name ?? "track.mid");
  const partNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const part of result?.source.parts ?? []) names[part.id] = part.name;
    return names;
  }, [result]);

  // Bars across the roll, from the tempo the driver actually achieved.
  const bars = result
    ? Math.round(
        (result.script.seconds * result.script.timing.achievedBpm) /
          60 /
          Number(result.source.meter.split("/")[0] ?? 4),
      )
    : 0;

  return (
    <main class="audio-layout">
      <AudioInputPane
        accept=".mid,.midi,audio/midi"
        prompt="Drop a MIDI file here, or pick one."
        demos={filesOfKind(project, "music").map((one) => ({ name: one, note: one }))}
        onPick={(one) => {
          location.hash = fileHash(one);
        }}
        demoLabel="Load track"
        sourceName={source?.name ?? null}
        onSource={(name, bytes) => setSource({ name, bytes })}
      >
        {result ? (
          <>
            <dl class="facts" data-testid="track-facts">
              <div>
                <dt>Tempo</dt>
                <dd>{result.source.bpm.toFixed(1)} BPM</dd>
              </div>
              <div>
                <dt>Meter</dt>
                <dd>{result.source.meter}</dd>
              </div>
              <div>
                <dt>Length</dt>
                <dd>{result.source.seconds.toFixed(1)} s</dd>
              </div>
              <div>
                <dt>Sections</dt>
                <dd>{result.source.sections.length}</dd>
              </div>
            </dl>

            <h3>Parts</h3>
            <p class="hint">
              The classifier&rsquo;s answer, with its confidence — and it is editable, because a
              wrong role is a wrong arrangement. Changing one is <code>--role</code>; unticking a
              part is <code>--drop</code>.
            </p>
            <table class="parts" data-testid="parts-table">
              <thead>
                <tr>
                  <th scope="col">Keep</th>
                  <th scope="col">Part</th>
                  <th scope="col">Role</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {result.source.parts.map((part) => {
                  const dropped = options.drop.includes(part.id);
                  return (
                    <tr key={part.id} class={dropped ? "part-dropped" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={!dropped}
                          aria-label={`keep ${part.name}`}
                          onChange={(event) => {
                            const keep = (event.currentTarget as HTMLInputElement).checked;
                            set(
                              "drop",
                              keep
                                ? options.drop.filter((id) => id !== part.id)
                                : [...options.drop, part.id],
                            );
                          }}
                        />
                      </td>
                      <td
                        title={`${part.id}${part.program === undefined ? "" : ` · GM program ${part.program}`}`}
                      >
                        {part.name}
                      </td>
                      <td>
                        <select
                          value={options.roles[part.id] ?? part.role}
                          aria-label={`role for ${part.name}`}
                          onChange={(event) => {
                            const role = (event.currentTarget as HTMLSelectElement)
                              .value as PartRole;
                            const roles = { ...options.roles };
                            if (role === part.role) delete roles[part.id];
                            else roles[part.id] = role;
                            set("roles", roles);
                          }}
                        >
                          {ROLES.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {part.notes}
                        <span class="muted-note">
                          {" "}
                          · {(part.roleConfidence * 100).toFixed(0)}% sure
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ) : null}
      </AudioInputPane>

      <section class="pane controls-pane" aria-labelledby="music-controls-heading">
        <h2 id="music-controls-heading">Console &amp; options</h2>

        <label class="field">
          <span>Console</span>
          <select
            value={options.console}
            data-testid="console-select"
            onChange={(event) => set("console", (event.currentTarget as HTMLSelectElement).value)}
          >
            {consoleList.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
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
          <span>Strategy</span>
          <select
            value={options.strategy}
            data-testid="strategy-select"
            onChange={(event) => set("strategy", (event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="auto">auto — run the tournament</option>
            {(active?.strategies ?? []).map((candidate) => (
              <option key={candidate.id} value={candidate.id} title={candidate.summary}>
                {candidate.id}
              </option>
            ))}
          </select>
        </label>

        <div class="field-row">
          <label class="field">
            <span>Tempo (BPM)</span>
            <input
              type="number"
              min="20"
              max="400"
              placeholder={result ? result.source.bpm.toFixed(0) : "detected"}
              value={options.bpm}
              data-testid="bpm-input"
              onInput={(event) => set("bpm", (event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span>Grid</span>
            <select
              value={options.tempo}
              onChange={(event) =>
                set("tempo", (event.currentTarget as HTMLSelectElement).value as "exact" | "snap")
              }
            >
              <option value="exact">exact — hold the source tempo</option>
              <option value="snap">snap — take a cheaper grid</option>
            </select>
          </label>
        </div>

        <div class="field-row">
          <label class="field">
            <span>Channel cap</span>
            <input
              type="number"
              min="1"
              max={active?.channels.length ?? 8}
              placeholder={String(active?.channels.length ?? "all")}
              value={options.channels}
              onInput={(event) => set("channels", (event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <fieldset class="field">
            <legend>Reserve for effects</legend>
            {(active?.channels ?? []).map((channel) => (
              <label class="check inline" key={channel.id}>
                <input
                  type="checkbox"
                  checked={options.reserve.includes(channel.id)}
                  onChange={(event) => {
                    const on = (event.currentTarget as HTMLInputElement).checked;
                    set(
                      "reserve",
                      on
                        ? [...options.reserve, channel.id]
                        : options.reserve.filter((id) => id !== channel.id),
                    );
                  }}
                />
                <span title={channel.summary}>{channel.id}</span>
              </label>
            ))}
          </fieldset>
        </div>

        <fieldset class="field effort">
          <legend>Effort</legend>
          {(["fast", "default", "max"] as const).map((value) => (
            <label key={value} class="radio">
              <input
                type="radio"
                name="arrange-effort"
                value={value}
                checked={options.effort === value}
                onChange={() => set("effort", value)}
              />
              <span>{value}</span>
            </label>
          ))}
          {options.effort === "fast" ? (
            <p class="hint">One candidate instead of the portfolio. Faster, and rarely as good.</p>
          ) : null}
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

        <label class="check">
          <input
            type="checkbox"
            checked={options.strict}
            onChange={(event) => set("strict", (event.currentTarget as HTMLInputElement).checked)}
          />
          <span>Strict: fail rather than drop a part (--strict)</span>
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
          <label class="field">
            <span>Extra loops in the WAV</span>
            <input
              type="number"
              min="0"
              max="8"
              value={options.loops}
              onInput={(event) => set("loops", (event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </fieldset>

        <button type="button" class="link" onClick={() => setOptions({ ...DEFAULT_ARRANGE })}>
          Reset all options
        </button>

        <CommandLine command={command} />
      </section>

      <div class="audio-results">
        <section class="pane" aria-labelledby="arrangement-heading">
          <h2 id="arrangement-heading">Arrangement</h2>

          {busy ? (
            <p class="status" role="status" data-testid="status">
              Arranging…
            </p>
          ) : null}
          {error ? (
            <p class="error" role="alert" data-testid="error">
              <strong>{error.code}</strong> {error.message}
              {error.hint ? <span class="hint"> {error.hint}</span> : null}
            </p>
          ) : null}

          {result && active ? (
            <>
              <ChannelPlan
                channels={active.channels}
                spans={result.script.channels}
                ticks={result.script.ticks}
                loopTick={result.script.loopTick}
                bars={bars}
                partNames={partNames}
              />

              <dl class="facts" data-testid="timing-facts">
                <div>
                  <dt>Tempo held</dt>
                  <dd>
                    {result.script.timing.achievedBpm.toFixed(2)} BPM
                    <span class="muted-note">
                      {" "}
                      · {result.script.timing.ppmError.toFixed(0)} ppm
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Worst onset</dt>
                  <dd>{result.script.timing.maxOnsetDeviationMs.toFixed(2)} ms</dd>
                </div>
                <div>
                  <dt>Driver</dt>
                  <dd>
                    {result.script.timing.source} at {result.script.rateHz.toFixed(1)} Hz
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
                  <dt>Drift</dt>
                  <dd>{result.script.timing.accumulates ? "accumulates" : "none"}</dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>{result.elapsedMs} ms</dd>
                </div>
              </dl>

              {result.dropped.length > 0 ? (
                <ul class="warnings" data-testid="dropped">
                  {result.dropped.map((entry, index) => (
                    <li key={index}>
                      <strong>{partNames[entry.partId] ?? entry.partId}</strong> — {entry.count}{" "}
                      {entry.kind}
                      {entry.count === 1 ? "" : "s"} dropped: {entry.reason}
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="hint">Nothing was dropped: every part reached a channel.</p>
              )}

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
                autoValue="auto"
                onPick={(strategy) => set("strategy", strategy)}
              />
            </>
          ) : busy ? null : (
            <p class="hint">Drop a MIDI file in, or load one from the example library.</p>
          )}
        </section>

        <AudioListenPane
          engine={engine}
          token={result?.token ?? null}
          pcm={result ? toPlayable(result.pcm) : null}
          source={null}
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
            wav: wavCommand(options, source?.name ?? "track.mid"),
            rom: romCommand(options.console, source?.name ?? "track.mid", ".gb"),
          }}
          onDeviceRate={(rate) => {
            previewRate.current = rate;
          }}
        >
          {/*
           * No A/B here, and the reason is worth stating: a MIDI file is a
           * score, not a recording. There is nothing to play it with that is not
           * a synthesizer, and the page will not become one (doc 07 §The audio
           * sections). The sound demaker's source *is* audio, and it does offer
           * the comparison.
           */}
          <p class="hint">
            One side only: the source is a MIDI file — a score, not a recording — so playing it
            would mean synthesizing it, and the one thing this page never does is synthesize.
          </p>
        </AudioListenPane>
      </div>
    </main>
  );
}
