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
export { parseMod, isMod, ModParseError, type ModParseResult } from "./score/mod.js";
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
export {
  ARAM_DIR,
  ARAM_DIR_PAGE,
  MASTER_VOLUME,
  sampleAram,
  sampleNumber,
  waveformBank,
  WAVEFORMS,
  type Waveform,
} from "./binding/sdsp-bank.js";
export { NOISE_VOICE, SDSP_MERGE_REGS, SDSP_REG, sdspChannelTag } from "./binding/sdsp.js";
// The Game Boy Advance's mixer bank, under names of its own: this console and
// the Super Nintendo both have a sample bank and they are nothing alike, so the
// two must never be reachable under one name (`binding/gba-bank.ts`).
export {
  bankBytes as gbaBankBytes,
  sampleBank as gbaSampleBank,
  sampleNumber as gbaSampleNumber,
  NOISE_SAMPLES as GBA_NOISE_SAMPLES,
  WAVEFORMS as GBA_WAVEFORMS,
  WAVE_SAMPLES as GBA_WAVE_SAMPLES,
  type Waveform as GbaWaveform,
} from "./binding/gba-bank.js";
export { gbaChannelTag, GBA_APU_CHANNELS, GBA_PSG_GAIN } from "./binding/gba.js";
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
  packScript,
  AudioRomError,
  PackError,
  gameAudioConsoles,
  gameDriverRate,
  hasGameAudio,
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
  buildPceGameAudio,
  resolvePceClock,
  PCE_AUDIO_BYTES,
  type PceGameAudio,
  type PceGameAudioInput,
  type PceGameAudioStats,
} from "./rom/pce-game.js";
export { pceChannelTag, pcePackTag } from "./binding/pce.js";
export {
  psgShadowInit,
  psgShadowPlan,
  psgShadowSlot,
  PSG_SHADOW,
  PSG_SHADOW_BYTES,
} from "./rom/psg.js";
export {
  shadowBias,
  shadowPlan,
  shadowReserve,
  NO_SHADOW,
  type ShadowChannel,
  type ShadowPlan,
  type ShadowRegister,
} from "./rom/shared.js";
export {
  buildSmsGameAudio,
  resolveSmsClock,
  SMS_AUDIO_BYTES,
  type SmsGameAudio,
  type SmsGameAudioInput,
  type SmsGameAudioStats,
} from "./rom/sms-game.js";
export { type DataHole } from "./rom/z80-player.js";
export { t6w28Binding } from "./binding/t6w28.js";
export {
  t6w28AttenuationOff,
  t6w28ChannelTag,
  t6w28ShadowSlot,
  T6W28_CHANNELS,
  T6W28_LEFT,
  T6W28_RIGHT,
  T6W28_SHADOW,
  T6W28_SHADOW_BYTES,
} from "./rom/t6w28.js";
export {
  buildNgpGameAudio,
  resolveNgpClock,
  NGP_AUDIO_BYTES,
  type NgpGameAudio,
  type NgpGameAudioInput,
  type NgpGameAudioStats,
} from "./rom/ngp-game.js";
export { wscBinding, wscChannelTag, wsWaveforms, WSC_SHARED_REG } from "./binding/wsc.js";
export {
  buildWscGameAudio,
  resolveWscClock,
  WSC_AUDIO_BYTES,
  type WscGameAudio,
  type WscGameAudioInput,
  type WscGameAudioStats,
} from "./rom/wsc-game.js";
export {
  wsDefaultWaveforms,
  wsWaveBank,
  WS_BANK_BYTES,
  WS_WAVE_BASE,
  type WsWaveform,
} from "./binding/wsc-bank.js";
export {
  buildSpcGameAudio,
  resolveSpcClock,
  SPC_CODE_BASE,
  SPC_IMAGE_BASE,
  SPC_PORT,
  STOP as SPC_STOP,
  type SpcGameAudio,
  type SpcGameAudioInput,
  type SpcGameAudioStats,
} from "./rom/spc-game.js";
export {
  buildMdGameAudio,
  resolveMdClock,
  MD_AUDIO_BYTES,
  type MdGameAudio,
  type MdGameAudioInput,
  type MdGameAudioStats,
} from "./rom/md-game.js";
export {
  buildGbaGameAudio,
  resolveGbaClock,
  GBA_AUDIO_BYTES,
  STOP as GBA_STOP,
  type GbaGameAudio,
  type GbaGameAudioInput,
  type GbaGameAudioStats,
} from "./rom/gba-game.js";
// The sample half's own shape, which the game backend needs to route one
// interrupt and the conformance harness needs to read the ring.
export {
  buildNdsGameAudio,
  NDS_AUDIO_BYTES,
  NDS_STOP,
  type NdsGameAudio,
  type NdsGameAudioInput,
  type NdsGameAudioStats,
} from "./rom/nds-game.js";
export {
  buildVbGameAudio,
  resolveVbClock,
  VB_AUDIO_BYTES,
  STOP as VB_STOP,
  type VbGameAudio,
  type VbGameAudioInput,
  type VbGameAudioStats,
} from "./rom/vb-game.js";
export {
  neogeoChannelOf,
  neogeoChannelTag,
  neogeoOwnerTag,
  neogeoPortOf,
} from "./rom/neogeo-driver.js";
export {
  buildNeogeoGameAudio,
  SFX_BASE as NEOGEO_SFX_BASE,
  STOP as NEOGEO_AUDIO_STOP,
  type NeogeoGameAudio,
  type NeogeoGameAudioInput,
  type NeogeoGameAudioStats,
} from "./rom/neogeo-game.js";
export { NDS_SPU_BASE, NDS_STATE_BASE } from "./rom/nds-driver.js";
export { ndsChannelTag, ndsPackTag } from "./binding/nds.js";
export { vbChannelTag, vbPackTag } from "./binding/vb.js";
export { NDS_BANK_BASE, ndsBank, ndsSampleRam } from "./binding/nds-bank.js";
export {
  GBA_AUDIO_IRQ,
  GBA_BLOCK_SAMPLES,
  GBA_RING_BLOCKS,
  GBA_RING_BYTES,
  GBA_RING_LEFT,
  GBA_RING_RIGHT,
} from "./rom/gba-driver.js";
// The SN76489's own side of the hand-off, shared by the two processors that
// drive it: a Z80 on the Sega 8-bits and a 68000 on the Mega Drive.
export { psgChannelTag, psgAttenuationOff, PSG_STEREO_REG } from "./rom/psg.js";
// And the Mega Drive's, which has to speak for two chips at once.
export { mdChannelTag, mdPort, MD_FM_CHANNELS, MD_PSG_PORT } from "./rom/md-chips.js";

// --- hearing it --------------------------------------------------------------
export { render, type RenderAudioOptions } from "./render.js";
// The deterministic transforms, exported for Level B: comparing our audio with a
// third-party core's is a *spectral* comparison (doc 16 §The proof), and it must
// run on the same FFT everything else here does rather than a second one.
export { fft, hann, spectrum, resample, ANALYSIS_RATE } from "./dsp.js";
export { encodeWav, type WavOptions } from "./encode/wav.js";
export { encodeFlac, type FlacOptions } from "./encode/flac.js";
export { encodeVgm, type VgmOptions } from "./encode/vgm.js";
export { encodeSpc, artifactFormat, type SpcOptions } from "./encode/spc.js";

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
