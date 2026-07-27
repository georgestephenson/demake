/**
 * `@demake/audio` — the music and sound demakers (docs 16, 17, 18).
 *
 * Any track becomes music a console can play; any sound becomes a chip effect.
 * The layer underneath — the chip models that make it audible — is
 * `@demake/chip`, and the split is the one doc 16 §Packages argues for: a
 * hardware model that depends on nothing, and conversion logic that depends on
 * it. `render` is the load-bearing export, because the CLI, the browser and the
 * desktop app all make sound through it and nothing else.
 *
 * Platform-pure on `core`'s terms, and under the same determinism rules — more
 * strictly, if anything, since audio DSP reaches for transcendentals constantly
 * and every one of them comes from the engine's own kernels.
 */

// --- the music demaker -------------------------------------------------------
export {
  arrangeScore,
  candidates,
  ArrangeError,
  type ArrangeOptions,
  type ArrangeResult,
  type Candidate,
  type CandidateScore,
  type Diagnostic,
} from "./arrange/index.js";
export { planArrangement, type ArrangementPlan, type ChannelAssignment } from "./arrange/plan.js";
export { analyze, barLength, type AnalyzeOptions } from "./analysis.js";

// --- ingest ------------------------------------------------------------------
export { parseMidi, isMidi, MidiParseError } from "./score/midi.js";
export {
  allNotes,
  dominantBpm,
  secondsAt,
  tempoAt,
  PPQ,
  type DrumClass,
  type MeterPoint,
  type Note,
  type Part,
  type PartRole,
  type Score,
  type Section,
  type TempoPoint,
} from "./score/types.js";

// --- the hardware side -------------------------------------------------------
export {
  countWrites,
  peakWritesPerTick,
  scriptSeconds,
  type ChannelFrame,
  type ChannelSpan,
  type ChipScript,
  type Dropped,
  type TickWrites,
  type TimingReport,
} from "./chipscript.js";
export { bindingFor, audioConsoles, UnsupportedConsoleError } from "./binding/registry.js";
export type { ChipBinding, DriverRateFit } from "./binding/types.js";
export { planTiming, verifyNonAccumulating, type TimingPlan } from "./timing.js";
export {
  centsToHz,
  foldIntoRange,
  hzToCents,
  snapPitch,
  snapVolume,
  type SnappedPitch,
} from "./pitch.js";

// --- the console hand-off ----------------------------------------------------
export {
  audioRomConsoles,
  buildAudioRom,
  buildGbAudioRom,
  packScript,
  AudioRomError,
  PackError,
  gameDriverRate,
  MAX_WRITES_PER_TICK,
  type AudioRomOptions,
  type AudioRomStats,
  type BuiltAudioRom,
  type ChannelTag,
  type DriverData,
} from "./rom/index.js";
export {
  buildGameAudio,
  gbChannelOf,
  STOP as AUDIO_STOP,
  type GameAudio,
  type GameAudioInput,
  type GameAudioStats,
  type GameEffect,
} from "./rom/gb-game.js";
export {
  buildNesGameAudio,
  nesChannelOf,
  resolveNesClock,
  NES_AUDIO_BYTES,
  type NesGameAudio,
  type NesGameAudioInput,
  type NesGameAudioStats,
} from "./rom/nes-game.js";
export {
  buildSmsGameAudio,
  resolveSmsClock,
  smsChannelTag,
  SMS_AUDIO_BYTES,
  type SmsGameAudio,
  type SmsGameAudioInput,
  type SmsGameAudioStats,
} from "./rom/sms-game.js";

// --- hearing it --------------------------------------------------------------
export { render, type RenderAudioOptions } from "./render.js";
export { encodeWav, type WavOptions } from "./encode/wav.js";
export { encodeVgm, type VgmOptions } from "./encode/vgm.js";

// --- the sound demaker -------------------------------------------------------
export {
  demakeSfx,
  gestureJob,
  runGesture,
  SFX_RATE_HZ,
  SfxError,
  type GestureJob,
  type GestureOutcome,
  type SfxOptions,
  type SfxResult,
  type SfxCandidateScore,
} from "./sfx/index.js";

// --- parallelism -------------------------------------------------------------
export { audioJobKinds } from "./jobs.js";
export {
  analyzeSound,
  limitLength,
  trim,
  type SoundClass,
  type SoundFeatures,
} from "./sfx/analyze.js";
export { decodeSound, isWav, SoundDecodeError, type DecodedSound } from "./sfx/decode.js";
export { GESTURES, gesturesFor, type Gesture, type GestureParams } from "./sfx/gestures.js";

// --- the sidecar -------------------------------------------------------------
export {
  arrangeManifest,
  encodeAudioManifest,
  sfxManifest,
  type ArrangeManifest,
  type AudioManifest,
  type SfxManifest,
} from "./manifest.js";

// --- checking it -------------------------------------------------------------
export { inspectScript, type AudioInspectResult, type AudioViolation } from "./inspect.js";
export { judgeArrangement, type JudgeResult, type MetricScore } from "./judge.js";
