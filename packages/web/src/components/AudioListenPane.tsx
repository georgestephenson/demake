/**
 * The Listen pane (doc 07 §The audio sections), shared by both demakers.
 *
 * Press play and hear exactly what the cartridge will play — that last word is
 * the whole design constraint, and it is why nothing in this pane makes a sound.
 * The samples were rendered by `@demake/chip`'s models in the worker and reach
 * Web Audio as a finished buffer (see `lib/audio-player.ts`).
 *
 * The rate is the one detail worth watching. The page asks for a 48 kHz context
 * and renders to match; a browser that refuses gets a *re-render* at the rate it
 * chose rather than a buffer for the browser to resample on its own terms, and
 * the pane says which rate it ended up playing at.
 *
 * The downloads are the CLI's outputs, one for one: the `.vgm` artifact, the
 * `--emit-manifest` sidecar, the sample-exact WAV that carries doc 16's
 * guarantee, and — where a driver backend exists — the cartridge that plays it.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

import { download } from "../lib/download.js";
import { audioSupported, AudioPlayer, toPlayable, type PlayablePcm } from "../lib/audio-player.js";
import { EngineError } from "../worker/client.js";
import type { AudioEngineClient } from "../worker/audio-client.js";

interface Props {
  engine: AudioEngineClient;
  /** Handle for the schedule the worker is holding, or `null` while converting. */
  token: number | null;
  /** The result, rendered at the rate the page last believed the device wanted. */
  pcm: PlayablePcm | null;
  /** The recording being demade, where there is one to compare against. */
  source: PlayablePcm | null;
  vgm: ArrayBuffer | null;
  stem: string;
  /** Cartridge title, for the ROM header. */
  title: string;
  seconds: number;
  hasRom: boolean;
  /** Why the ROM button is off, when it is. */
  romReason: string;
  /** `demake render`'s options, as the Listen controls have them. */
  render: { sampleRate?: number; outputStage?: "board"; loops?: number };
  /** The CLI line each download corresponds to. */
  commands: { wav: string; flac: string; rom: string };
  /** Told once, the first time the audio device names its own rate. */
  onDeviceRate: (rate: number) => void;
  children?: ComponentChildren;
}

export function AudioListenPane({
  engine,
  token,
  pcm,
  source,
  vgm,
  stem,
  title,
  seconds,
  hasRom,
  romReason,
  render,
  commands,
  onDeviceRate,
  children,
}: Props) {
  const player = useRef<AudioPlayer | null>(null);
  const [playing, setPlaying] = useState<"result" | "source" | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The context outlives every conversion in the section, and is closed once.
  useEffect(() => () => player.current?.close(), []);

  // A result that has been replaced must not keep playing over its successor.
  useEffect(() => {
    player.current?.stop();
    setPlaying(null);
  }, [token]);

  const start = useCallback(
    async (which: "result" | "source") => {
      if (!audioSupported()) return;
      let device = player.current;
      if (!device) {
        // The click *is* the gesture a browser wants before it will start a
        // context, which is the whole reason this is a button.
        device = new AudioPlayer();
        player.current = device;
        onDeviceRate(device.sampleRate);
        setRate(device.sampleRate);
      }
      setError(null);
      await device.resume();

      let buffer = which === "source" ? source : pcm;
      if (!buffer) return;
      if (which === "result" && buffer.sampleRate !== device.sampleRate && token !== null) {
        // Rendered again at the device's rate rather than handed over for the
        // browser to resample — that resampling differs per engine, and this is
        // the audio the file download claims to be.
        setBusy("render");
        try {
          buffer = toPlayable(await engine.preview(token, device.sampleRate));
        } catch (err) {
          setError(err instanceof EngineError ? err.message : String(err));
          return;
        } finally {
          setBusy(null);
        }
      }
      setPlaying(which);
      device.play(buffer, () => setPlaying(null));
    },
    [engine, onDeviceRate, pcm, source, token],
  );

  const stop = useCallback(() => {
    player.current?.stop();
    setPlaying(null);
  }, []);

  const save = useCallback(
    async (what: "wav" | "flac" | "manifest" | "rom") => {
      if (token === null) return;
      setBusy(what);
      setError(null);
      try {
        const artifact = await engine.artifact(token, what, stem, title, render);
        download(artifact.name, new Uint8Array(artifact.bytes));
      } catch (err) {
        setError(err instanceof EngineError ? `${err.code} ${err.message}` : String(err));
      } finally {
        setBusy(null);
      }
    },
    [engine, render, stem, title, token],
  );

  const ready = token !== null && pcm !== null;

  return (
    <section class="pane listen-pane" aria-labelledby="listen-heading">
      <h2 id="listen-heading">Listen</h2>

      <div class="listen-transport">
        <button
          type="button"
          data-testid="play-result"
          disabled={!ready || !audioSupported() || busy !== null}
          aria-pressed={playing === "result"}
          onClick={() => (playing === "result" ? stop() : void start("result"))}
        >
          {playing === "result" ? "Stop" : "Play the result"}
        </button>
        {source ? (
          <button
            type="button"
            data-testid="play-source"
            disabled={!audioSupported() || busy !== null}
            aria-pressed={playing === "source"}
            onClick={() => (playing === "source" ? stop() : void start("source"))}
          >
            {playing === "source" ? "Stop" : "Play the source"}
          </button>
        ) : null}
        <span class="audio-stat" data-testid="listen-stat">
          {seconds > 0 ? `${seconds.toFixed(2)} s` : "—"}
          {rate === null ? "" : ` · ${rate} Hz`}
        </span>
      </div>

      {!audioSupported() ? (
        <p class="hint">
          This browser has no Web Audio, so the page cannot play anything here. The downloads below
          are unaffected.
        </p>
      ) : null}
      {rate !== null && rate !== 48000 ? (
        <p class="hint" data-testid="rate-note">
          Your browser refused a 48 kHz audio context and gave {rate} Hz, so the schedule was
          rendered again at that rate — nothing is resampled.
        </p>
      ) : null}
      {busy === "render" ? <p class="status">Rendering at the device&rsquo;s rate…</p> : null}
      {error ? (
        <p class="error" role="alert">
          {error}
        </p>
      ) : null}

      {children}

      <div class="exports" data-testid="audio-exports">
        <button
          type="button"
          data-testid="export-vgm"
          disabled={!vgm}
          title="the artifact demake arrange/sfx writes with -o"
          onClick={() => vgm && download(`${stem}.vgm`, new Uint8Array(vgm))}
        >
          VGM
        </button>
        <button
          type="button"
          data-testid="export-wav"
          disabled={!ready || busy !== null}
          title={commands.wav}
          onClick={() => void save("wav")}
        >
          {busy === "wav" ? "…" : "WAV"}
        </button>
        <button
          type="button"
          data-testid="export-flac"
          disabled={!ready || busy !== null}
          title={commands.flac}
          onClick={() => void save("flac")}
        >
          {busy === "flac" ? "…" : "FLAC"}
        </button>
        <button
          type="button"
          data-testid="export-manifest"
          disabled={!ready || busy !== null}
          title="the sidecar demake arrange/sfx writes with --emit-manifest"
          onClick={() => void save("manifest")}
        >
          {busy === "manifest" ? "…" : "Manifest"}
        </button>
        <button
          type="button"
          data-testid="export-rom"
          disabled={!ready || !hasRom || busy !== null}
          title={hasRom ? commands.rom : romReason}
          onClick={() => void save("rom")}
        >
          {busy === "rom" ? "…" : "Cartridge"}
        </button>
      </div>
      <p class="hint">
        The WAV is sample-exact and is what the hardware plays — the guarantee doc 16 makes, and the
        reason the lossy formats are not offered next to it. The cartridge is assembled in the page
        by our own SM83 assembler, with a driver generated for this schedule: no toolchain, and the
        same bytes <code>demake gen … --format rom</code> writes.
      </p>
    </section>
  );
}
