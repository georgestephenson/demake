/**
 * The audio engine worker (doc 07 §The audio sections).
 *
 * This module is the *only* place the web app touches `@demake/audio`, and it
 * calls exactly the API the CLI calls — same `arrangeScore`, same `demakeSfx`,
 * same `render`, same sidecar builder, same `buildAudioRom` — so what the page
 * hands you is what `demake` writes on the command line.
 *
 * **Nothing here computes a sample the chip models did not.** `render()` is the
 * one path to audio, exactly as doc 16 §The render contract requires; the page's
 * job is to hand the PCM it returns to a buffer source and get out of the way.
 *
 * The worker holds each schedule it produces, keyed by a token. A `ChipScript` is
 * thousands of register writes and the panes need none of them — but the sidecar,
 * a cartridge and a re-render at the device's own rate all do, so the script
 * stays here and the page asks for those by token.
 */

import {
  analyze,
  analyzeSound,
  ArrangeError,
  arrangeManifest,
  arrangeScore,
  audioConsoles,
  audioRomConsoles,
  AudioRomError,
  buildAudioRom,
  candidates,
  decodeSound,
  demakeSfx,
  dominantBpm,
  limitLength,
  encodeAudioManifest,
  encodeWav,
  MidiParseError,
  PackError,
  parseMidi,
  render,
  scriptSeconds,
  secondsAt,
  sfxManifest,
  SfxError,
  SoundDecodeError,
  trim,
  UnsupportedConsoleError,
  type ArrangeResult,
  type ChipScript,
  type Score,
  type SfxResult,
} from "@demake/audio";
import { consoleLabel, consoles, type AudioChannelSpec, type AudioSpec } from "@demake/core";

import { toArrangeOptions, toRenderOptions, toSfxOptions } from "../lib/audio-options.js";
import type {
  ArrangePayload,
  AudioArtifact,
  AudioConsoleInfo,
  AudioWorkerRequest,
  AudioWorkerResponse,
  ChannelInfo,
  PcmPayload,
  ScoreInfo,
  ScriptInfo,
  SfxPayload,
} from "./audio-protocol.js";

/** A frequency, rounded the way a spec sheet would print it. */
function hz(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${value.toFixed(0)} Hz`;
}

/** One-line summary of what a voice can do, derived from its spec. */
function channelSummary(channel: AudioChannelSpec): string {
  const bits: string[] = [channel.kind];
  if (channel.pitch) {
    const { clockHz, step, minDivider, maxDivider } = channel.pitch;
    bits.push(`${hz(clockHz / (step * maxDivider))}–${hz(clockHz / (step * minDivider))}`);
  }
  bits.push(channel.volume.steps === 1 ? "fixed volume" : `${channel.volume.steps} levels`);
  if (channel.duties) bits.push(`${channel.duties.length} duties`);
  if (channel.noise) bits.push(`${channel.noise.periods} noise periods`);
  if (channel.waveform) bits.push(`${channel.waveform.samples}-sample wavetable`);
  return bits.join(" · ");
}

function channelInfo(spec: AudioSpec): ChannelInfo[] {
  return spec.channels.map((channel) => ({
    id: channel.id,
    kind: channel.kind,
    summary: channelSummary(channel),
  }));
}

/**
 * The consoles the audio demakers can target, asked of the registry.
 *
 * Never a list in this file: a console gains its entry the moment its chip has a
 * binding, exactly as the image picker gains one when a spec lands.
 */
function consoleList(): AudioConsoleInfo[] {
  const withRom = new Set(audioRomConsoles());
  const supported = new Set(audioConsoles());
  const out: AudioConsoleInfo[] = [];
  for (const spec of consoles()) {
    if (!supported.has(spec.id) || !spec.audio) continue;
    const audio = spec.audio;
    const rate = audio.driver.frameRate;
    out.push({
      id: spec.id,
      name: spec.name,
      label: consoleLabel(spec),
      tier: spec.tier,
      chips: [...audio.chips],
      channels: channelInfo(audio),
      writesPerTick: audio.driver.writesPerTick,
      romBytes: audio.budgets.romBytes,
      summary:
        `${audio.channels.length} channels · ${audio.chips.join(" + ")} · ` +
        `${audio.driver.sources[0]} at ${(rate.num / rate.den).toFixed(1)} Hz`,
      strategies: candidates(audio).map((candidate) => ({
        id: candidate.id,
        summary: candidate.summary,
      })),
      hasRom: withRom.has(spec.id),
    });
  }
  return out;
}

/** Copy PCM into transferable buffers; the page hands them to Web Audio as-is. */
function pcmPayload(pcm: { sampleRate: number; channels: Float32Array[] }): PcmPayload {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((channel) => {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      return copy.buffer;
    }),
  };
}

function bytesPayload(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/** The source track, as analysis found it — every part, before `--drop`. */
function scoreInfo(score: Score): ScoreInfo {
  const meter = score.meter[0];
  return {
    bpm: dominantBpm(score),
    meter: meter ? `${meter.numerator}/${meter.denominator}` : "4/4",
    seconds: secondsAt(score, score.durationTicks),
    parts: score.parts.map((part) => ({
      id: part.id,
      name: part.name,
      role: part.role,
      roleConfidence: part.roleConfidence,
      notes: part.notes.length,
      polyphony: part.polyphony,
      ...(part.program === undefined ? {} : { program: part.program }),
    })),
    sections: score.sections.map((section) => ({
      label: section.label,
      startSeconds: secondsAt(score, section.startTick),
      endSeconds: secondsAt(score, section.endTick),
    })),
    loop: score.loop
      ? {
          startSeconds: secondsAt(score, score.loop.startTick),
          endSeconds: secondsAt(score, score.loop.endTick),
        }
      : null,
    provenance: score.provenance.format,
  };
}

function scriptInfo(script: ChipScript): ScriptInfo {
  return {
    console: script.console,
    chips: [...script.chips],
    ticks: script.ticks.length,
    seconds: scriptSeconds(script),
    loopTick: script.loopTick,
    rateHz: script.driver.rate.num / script.driver.rate.den,
    channels: script.channels,
    timing: script.timing,
    budgets: script.budgets,
  };
}

/**
 * Analysis window for the pane's envelope traces, in samples.
 *
 * Finer than the analysis the *fit* runs at, and deliberately so: an effect can
 * be forty milliseconds long, which is two frames of the 1024-sample window
 * `analyzeSound` defaults to — enough to fit against, nowhere near enough to
 * draw. Both traces use these settings, so the comparison stays honest.
 */
const DISPLAY_FRAME = 256;
const DISPLAY_HOP = 64;

/** Peak-normalized loudness over time, at the resolution the pane draws at. */
function displayEnvelope(samples: Float32Array, sampleRate: number): number[] {
  return analyzeSound(samples, { sampleRate, frameSize: DISPLAY_FRAME, hop: DISPLAY_HOP }).envelope;
}

/** One held schedule, and what a download button needs to rebuild from it. */
interface Held {
  script: ChipScript;
  manifest: Uint8Array;
}

const held = new Map<number, Held>();
let nextToken = 1;

/** Keep the last few, so flipping between strategies does not re-run anything. */
function hold(entry: Held): number {
  const token = nextToken++;
  held.set(token, entry);
  for (const key of held.keys()) {
    if (held.size <= 4) break;
    held.delete(key);
  }
  return token;
}

function heldFor(token: number): Held {
  const entry = held.get(token);
  if (!entry) {
    throw new ArrangeError("E_STALE_RESULT", "that result has expired — convert again");
  }
  return entry;
}

function runArrange(request: AudioWorkerRequest & { kind: "arrange" }): ArrangePayload {
  const started = performance.now();
  const score = parseMidi(new Uint8Array(request.source));
  const result: ArrangeResult = arrangeScore(score, toArrangeOptions(request.options));
  const pcm = render(result.script, {
    ...toRenderOptions(request.options),
    sampleRate: request.previewRate,
  });
  const token = hold({
    script: result.script,
    manifest: encodeAudioManifest(arrangeManifest(result)),
  });
  return {
    token,
    vgm: bytesPayload(result.artifact),
    pcm: pcmPayload(pcm),
    // The *whole* part list, classified but not filtered: the pane's per-part
    // role and drop controls have to keep offering a part after it is dropped.
    source: scoreInfo(analyze(score)),
    script: scriptInfo(result.script),
    dropped: result.dropped,
    diagnostics: result.diagnostics,
    tournament: {
      winner: result.tournament.winner,
      candidates: result.tournament.candidates.map((candidate) => ({
        id: candidate.id,
        summary: candidate.summary,
        aggregate: candidate.aggregate,
        metrics: candidate.metrics.map((metric) => ({
          id: metric.id,
          score: metric.score,
          raw: metric.raw,
          group: metric.group,
        })),
        ...(candidate.disqualified === undefined
          ? {}
          : { disqualified: { reason: candidate.disqualified.reason } }),
      })),
    },
    elapsedMs: Math.round(performance.now() - started),
  };
}

async function runSfx(request: AudioWorkerRequest & { kind: "sfx" }): Promise<SfxPayload> {
  const started = performance.now();
  const bytes = new Uint8Array(request.source);
  const result: SfxResult = await demakeSfx(bytes, toSfxOptions(request.options));
  const pcm = render(result.script, {
    ...toRenderOptions(request.options),
    sampleRate: request.previewRate,
  });
  // The A side of the A/B is decoded by `@demake/audio`'s own WAV reader, never
  // by the browser's: a comparison is only worth making when both sides came
  // through the same door. It is trimmed and length-limited exactly as the
  // demaker trims it, because the silence either side of a recording is not part
  // of what was fitted — playing or drawing it would compare the result against
  // something the fitter never saw.
  const decoded = decodeSound(bytes);
  const heard = limitLength(trim(decoded.samples), result.features.durationSeconds);
  const token = hold({ script: result.script, manifest: encodeAudioManifest(sfxManifest(result)) });
  const features = result.features;
  // The chip's output measured exactly as the recording was — same function,
  // same settings — which is what makes the two traces in the pane comparable
  // rather than suggestive. The fitted one is cut to the schedule's own length:
  // `render` leaves a quarter-second tail so a decay is not clipped, and drawing
  // that tail against a trimmed recording would make every effect look far
  // longer than it is.
  const frameRate = decoded.sampleRate / DISPLAY_HOP;
  const sounding = Math.max(1, Math.round(scriptSeconds(result.script) * frameRate));
  return {
    token,
    vgm: bytesPayload(result.artifact),
    pcm: pcmPayload(pcm),
    sourcePcm: pcmPayload({ sampleRate: decoded.sampleRate, channels: [heard] }),
    script: scriptInfo(result.script),
    soundClass: result.soundClass,
    features: {
      durationSeconds: features.durationSeconds,
      attackSeconds: features.attackSeconds,
      meanF0: features.meanF0,
      startF0: features.startF0,
      endF0: features.endF0,
      voicedFraction: features.voicedFraction,
    },
    envelopes: {
      frameRate,
      source: displayEnvelope(heard, decoded.sampleRate),
      fitted: displayEnvelope(pcm.channels[0] as Float32Array, pcm.sampleRate).slice(0, sounding),
    },
    placement: {
      channelId: result.placement.channelId,
      priority: result.placement.priority,
      prefers: [...result.placement.prefers],
    },
    tournament: result.tournament,
    diagnostics: result.diagnostics,
    elapsedMs: Math.round(performance.now() - started),
  };
}

async function buildArtifact(
  entry: Held,
  request: AudioWorkerRequest & { kind: "artifact" },
): Promise<AudioArtifact> {
  switch (request.what) {
    case "manifest":
      return { name: `${request.stem}.json`, bytes: bytesPayload(entry.manifest) };
    case "wav":
      // Rendered here and encoded by the same `encodeWav` the CLI writes files
      // with, so the download is sample-exact and carries doc 16's guarantee
      // rather than merely resembling it.
      return {
        name: `${request.stem}.wav`,
        bytes: bytesPayload(encodeWav(render(entry.script, request.render))),
      };
    case "rom": {
      const built = await buildAudioRom(entry.script, { title: request.title });
      return { name: `${request.stem}${built.suffix}`, bytes: bytesPayload(built.bytes) };
    }
  }
}

function post(message: AudioWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

/**
 * Turn an engine error into the code, message and hint a pane shows.
 *
 * Every one of these is a failure a user reaches by dropping the wrong file in,
 * so each keeps the engine's own words instead of being flattened into
 * "conversion failed".
 */
function errorResponse(id: number, err: unknown): AudioWorkerResponse {
  if (err instanceof ArrangeError || err instanceof SfxError) {
    return { id, ok: false, code: err.code, message: err.message };
  }
  if (err instanceof AudioRomError || err instanceof PackError) {
    return {
      id,
      ok: false,
      code: err.code,
      message: err.message,
      ...(err.hint === undefined ? {} : { hint: err.hint }),
    };
  }
  if (err instanceof MidiParseError) {
    return {
      id,
      ok: false,
      code: "E_BAD_INPUT",
      message: err.message,
      hint: "the music demaker takes MIDI; tracker and lossy-audio input arrive with the transcription front end (doc 17 §Input).",
    };
  }
  if (err instanceof SoundDecodeError) {
    return { id, ok: false, code: "E_BAD_INPUT", message: err.message };
  }
  if (err instanceof UnsupportedConsoleError) {
    return { id, ok: false, code: "E_UNSUPPORTED_CONSOLE", message: err.message };
  }
  return { id, ok: false, code: "E_INTERNAL", message: String((err as Error)?.message ?? err) };
}

self.addEventListener("message", async (event: MessageEvent<AudioWorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.kind) {
      case "consoles": {
        post({ id: request.id, ok: true, kind: "consoles", consoles: consoleList() });
        return;
      }
      case "arrange": {
        const result = runArrange(request);
        post({ id: request.id, ok: true, kind: "arrange", result }, [
          result.vgm,
          ...result.pcm.channels,
        ]);
        return;
      }
      case "sfx": {
        const result = await runSfx(request);
        post({ id: request.id, ok: true, kind: "sfx", result }, [
          result.vgm,
          ...result.pcm.channels,
          ...result.sourcePcm.channels,
        ]);
        return;
      }
      case "preview": {
        const pcm = pcmPayload(
          render(heldFor(request.token).script, { sampleRate: request.sampleRate }),
        );
        post({ id: request.id, ok: true, kind: "preview", pcm }, pcm.channels);
        return;
      }
      case "artifact": {
        const artifact = await buildArtifact(heldFor(request.token), request);
        post({ id: request.id, ok: true, kind: "artifact", artifact }, [artifact.bytes]);
        return;
      }
    }
  } catch (err) {
    post(errorResponse(request.id, err));
  }
});
