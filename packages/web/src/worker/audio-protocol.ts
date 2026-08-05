/**
 * The audio worker protocol (doc 07 §The audio sections).
 *
 * The counterpart of `protocol.ts` for `@demake/audio`, and separate from it for
 * the reason doc 07 gives: the chip models, the decoders and the analysis DSP are
 * a large payload, and someone who came to convert an image must not download
 * any of it. Only the two audio sections import this worker, so only they pay.
 *
 * The rule the payload shapes follow is the same one the image protocol follows:
 * **plain data plus transferable buffers**. A `ChipScript` with thousands of
 * ticks never crosses the boundary — the pane needs its channel plan, its timing
 * and its budgets, not its register writes — so the script stays in the worker
 * behind a token and the artifacts that quote it (the manifest, a ROM, a WAV at
 * another rate) are asked for by that token when a button is pressed.
 */

import type {
  ChannelSpan,
  Diagnostic,
  Dropped,
  PartRole,
  SfxCandidateScore,
  SoundClass,
  TimingReport,
} from "@demake/audio";

/** One arrangement candidate's score, as the tournament reports it. */
export interface ArrangeCandidateScore {
  id: string;
  summary: string;
  aggregate: number;
  metrics: { id: string; score: number; raw: number; group: string }[];
  disqualified?: { reason: string };
}

/** Rendered audio, ready for an `AudioBufferSourceNode`. */
export interface PcmPayload {
  sampleRate: number;
  /** One `Float32Array` buffer per channel. */
  channels: ArrayBuffer[];
}

/** One hardware voice, as the console picker and the piano roll show it. */
export interface ChannelInfo {
  id: string;
  kind: string;
  /** One-line constraint summary, e.g. "pulse · 12.5–1048 Hz · 16 levels". */
  summary: string;
}

/** An audio-capable console (derived from its `AudioSpec`, never listed here). */
export interface AudioConsoleInfo {
  id: string;
  name: string;
  /** Every name the console was sold under, as one string (doc 03 §Names). */
  label: string;
  tier: 1 | 2 | 3;
  chips: string[];
  channels: ChannelInfo[];
  /** Register writes one driver tick may perform. */
  writesPerTick: number;
  /** Bytes of ROM a track may occupy before the budget stage intervenes. */
  romBytes: number;
  /** One-line summary for the picker. */
  summary: string;
  /** Arrangement candidates for this console's chip. */
  strategies: { id: string; summary: string }[];
  /** Whether `gen --format rom` can build a cartridge that plays a schedule. */
  hasRom: boolean;
}

/** One source part, as the classifier described it. */
export interface PartInfo {
  id: string;
  name: string;
  role: PartRole;
  roleConfidence: number;
  notes: number;
  polyphony: number;
  program?: number;
}

/** The source track, before anything about a console is known. */
export interface ScoreInfo {
  /** The tempo in force for the most ticks — what `--bpm` overrides. */
  bpm: number;
  meter: string;
  seconds: number;
  parts: PartInfo[];
  sections: { label: string; startSeconds: number; endSeconds: number }[];
  loop: { startSeconds: number; endSeconds: number } | null;
  provenance: string;
}

/** What a script costs, and how exactly it held the tempo. */
export interface ScriptInfo {
  console: string;
  chips: string[];
  ticks: number;
  seconds: number;
  /** Tick playback returns to; `-1` for a one-shot. */
  loopTick: number;
  rateHz: number;
  channels: ChannelSpan[];
  timing: TimingReport;
  budgets: { writes: number; peakWritesPerTick: number; writeBudget: number };
}

/** Everything `arrange` produces for the UI. */
export interface ArrangePayload {
  /** Handle for the schedule the worker is holding onto. */
  token: number;
  vgm: ArrayBuffer;
  pcm: PcmPayload;
  /** The source as analysis found it — every part, before `--drop`. */
  source: ScoreInfo;
  script: ScriptInfo;
  dropped: Dropped[];
  diagnostics: Diagnostic[];
  tournament: { winner: string; candidates: ArrangeCandidateScore[] };
  elapsedMs: number;
}

/** Everything `sfx` produces for the UI. */
export interface SfxPayload {
  token: number;
  vgm: ArrayBuffer;
  pcm: PcmPayload;
  /** The recorded source, decoded by `@demake/audio` — never by the browser. */
  sourcePcm: PcmPayload;
  script: ScriptInfo;
  soundClass: SoundClass;
  /** What the analysis made of the recording. */
  features: {
    durationSeconds: number;
    attackSeconds: number;
    meanF0: number;
    startF0: number;
    endF0: number;
    voicedFraction: number;
  };
  /**
   * Peak-normalized loudness over time, for the recording and for the chip.
   *
   * Both measured by `analyzeSound` at the same frame rate, because the pane's
   * whole claim is that they are comparable.
   */
  envelopes: { frameRate: number; source: number[]; fitted: number[] };
  placement: { channelId: string; priority: number; prefers: string[] };
  tournament: { winner: string; candidates: SfxCandidateScore[] };
  diagnostics: Diagnostic[];
  elapsedMs: number;
}

/** A file the page hands the user. */
export interface AudioArtifact {
  name: string;
  bytes: ArrayBuffer;
}

/** The option record the music demaker edits — one field per `arrange` flag. */
export interface ArrangeOptionsUi {
  console: string;
  strategy: string;
  bpm: string; // "" = detected
  tempo: "exact" | "snap";
  /** Part id → role, from the source pane's per-part picker (`--role`). */
  roles: Record<string, PartRole>;
  /** Part ids excluded outright (`--drop`). */
  drop: string[];
  channels: string; // "" = all
  /** Channel ids held back for sound effects (`--reserve`). */
  reserve: string[];
  effort: "fast" | "default" | "max";
  strict: boolean;
  title: string;
  outputStage: "raw" | "board";
  sampleRate: string;
  loops: string;
}

/** The option record the sound demaker edits — one field per `sfx` flag. */
export interface SfxOptionsUi {
  console: string;
  strategy: string; // "" = auto (the gesture tournament)
  maxLength: string;
  effort: "fast" | "default" | "max";
  title: string;
  outputStage: "raw" | "board";
  sampleRate: string;
  loops: string;
}

export type AudioWorkerRequest =
  | { id: number; kind: "consoles" }
  | {
      id: number;
      kind: "arrange";
      source: ArrayBuffer;
      options: ArrangeOptionsUi;
      /** Rate to render the preview at — the audio device's, once there is one. */
      previewRate: number;
    }
  | {
      id: number;
      kind: "sfx";
      source: ArrayBuffer;
      options: SfxOptionsUi;
      previewRate: number;
    }
  /** Re-render a held schedule, for playback at a rate the device chose. */
  | { id: number; kind: "preview"; token: number; sampleRate: number }
  /** Build a downloadable artifact from a held schedule. */
  | {
      id: number;
      kind: "artifact";
      token: number;
      what: "wav" | "manifest" | "rom";
      stem: string;
      /** Cartridge title, for `rom`. */
      title: string;
      /** `demake render`'s options, for `wav`. */
      render: { sampleRate?: number; outputStage?: "board"; loops?: number };
    };

export type AudioWorkerResponse =
  | { id: number; ok: true; kind: "consoles"; consoles: AudioConsoleInfo[] }
  | { id: number; ok: true; kind: "arrange"; result: ArrangePayload }
  | { id: number; ok: true; kind: "sfx"; result: SfxPayload }
  | { id: number; ok: true; kind: "preview"; pcm: PcmPayload }
  | { id: number; ok: true; kind: "artifact"; artifact: AudioArtifact }
  | { id: number; ok: false; code: string; message: string; hint?: string };
