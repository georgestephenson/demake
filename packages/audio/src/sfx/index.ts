/**
 * `sfx` — the sound demaker (doc 18).
 *
 * A recorded sound becomes a short chip effect that can fire alongside music.
 * The fitting loop is the part worth understanding: every candidate is rendered
 * **through the chip model** and compared against the source, so the optimizer
 * can never propose something the hardware would refuse. That is affordable
 * only because the five-second rule bounds the search — three hundred driver
 * ticks is small enough to synthesize thousands of times — which is why the
 * limit is a design decision rather than a restriction being tolerated.
 */

import {
  defineJob,
  getConsole,
  inlineExecutor,
  jobHandlers,
  math,
  sourceHash,
  unwrap,
  type AudioSpec,
  type Executor,
} from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import { silentFrames, type ChipBinding, type DriverRateFit } from "../binding/types.js";
import type { ChannelFrame, ChipScript, TickWrites } from "../chipscript.js";
import { countWrites, peakWritesPerTick } from "../chipscript.js";
import { correlation, resample, resize } from "../dsp.js";
import { snapPitch } from "../pitch.js";
import { artifactFormat, encodeSpc } from "../encode/spc.js";
import { encodeVgm } from "../encode/vgm.js";
import { encodeWav } from "../encode/wav.js";
import { inspectScript } from "../inspect.js";
import { render } from "../render.js";
import { analyzeSound, limitLength, trim, type SoundClass, type SoundFeatures } from "./analyze.js";
import { decodeSound } from "./decode.js";
import { gesturesFor, seedParams, type Gesture, type GestureParams } from "./gestures.js";

export interface SfxOptions {
  console: string;
  /** Seconds the effect may last; the budget doc 18 is built around. */
  maxLength?: number;
  /** Pin one gesture family instead of running the tournament. */
  strategy?: string;
  effort?: "fast" | "default" | "max";
  /** Channels the effect may use; one unless a caller insists. */
  channels?: number;
  title?: string;
  /**
   * Driver rate to fit the effect to, in Hz.
   *
   * An effect on its own gets {@link SFX_RATE_HZ}, which is chosen for how sharp
   * an attack it can draw. An effect that has to play *alongside music* gets the
   * game's rate instead, because one timer produces one rate and both streams
   * step on it (doc 16 §Two streams, one clock).
   */
  rateHz?: number;
  /**
   * Where the gesture families are fitted (doc 18 §The tournament).
   *
   * Families cannot see each other, so an edge with threads to spare can hand
   * one in. Omitted, they are fitted on this thread in order — same effect, same
   * bytes.
   */
  executor?: Executor;
}

/** One family's best fit, with its score. */
export interface SfxCandidateScore {
  id: string;
  summary: string;
  aggregate: number;
  metrics: { id: string; score: number }[];
  disqualified?: { reason: string };
}

export interface SfxResult {
  script: ChipScript;
  artifact: Uint8Array;
  /** What the source turned out to be, and what drove the class gate. */
  features: SoundFeatures;
  soundClass: SoundClass;
  /** Which channel the effect wants, and how badly it wants it. */
  placement: {
    channelId: string;
    /** Higher preempts lower when two effects collide. */
    priority: number;
    /** Channel kinds this effect can fall back to. */
    prefers: readonly string[];
  };
  tournament: { winner: string; candidates: SfxCandidateScore[] };
  diagnostics: { code: string; severity: "error" | "warning" | "info"; message: string }[];
}

/** Thrown when no eligible gesture can represent the sound. */
export class SfxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SfxError";
  }
}

/** The driver rate effects run at: fine enough for a sharp attack. */
export const SFX_RATE_HZ = 240;
const DEFAULT_MAX_LENGTH = 5;

/** The cheap analysis the fitting loop scores against (doc 18 §Stage 3). */
const SCORING_RATE = 16000;
const SCORING_FRAME = 512;
const SCORING_HOP = 256;

/**
 * Everything the tournament derives before it knows which gesture it is fitting.
 *
 * Cheap next to the fitting — around a twentieth of an effect's work — but not
 * free, and every gesture needs all of it, so it is memoised by content the way
 * the image path's prologue is (`@demake/core`'s `candidate.ts`). One worker
 * handed four gestures for one sound analyses it once.
 */
interface SfxPrologue {
  readonly consoleSpec: ReturnType<typeof getConsole>;
  readonly spec: AudioSpec;
  readonly binding: ChipBinding;
  readonly features: SoundFeatures;
  readonly diagnostics: SfxResult["diagnostics"];
  readonly fit: DriverRateFit;
  readonly noiseIndex: number;
  readonly pitchedIndex: number;
  readonly portfolio: readonly Gesture[];
  readonly scoringTarget: SoundFeatures;
  readonly seed: GestureParams;
}

/**
 * The prologue cache: two sounds, for the same reason the image path keeps two.
 *
 * Keyed by a digest and confirmed by comparing the bytes, because a collision
 * would demake one effect from another's waveform and "unlikely" is not a
 * standard an output-byte guarantee is held to.
 */
const PROLOGUE_CACHE_ENTRIES = 2;
const prologueCache: { key: string; bytes: Uint8Array; value: SfxPrologue }[] = [];

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function prologueKey(bytes: Uint8Array, options: SfxOptions): string {
  const entries = Object.entries(options)
    .filter(([name]) => name !== "strategy")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${sourceHash(bytes)}:${bytes.length}:${JSON.stringify(entries)}`;
}

function prologue(bytes: Uint8Array, options: SfxOptions): SfxPrologue {
  const key = prologueKey(bytes, options);
  const hit = prologueCache.find((entry) => entry.key === key && sameBytes(entry.bytes, bytes));
  if (hit) return hit.value;
  const value = derivePrologue(bytes, options);
  prologueCache.unshift({ key, bytes, value });
  if (prologueCache.length > PROLOGUE_CACHE_ENTRIES) prologueCache.length = PROLOGUE_CACHE_ENTRIES;
  return value;
}

function derivePrologue(bytes: Uint8Array, options: SfxOptions): SfxPrologue {
  const consoleSpec = getConsole(options.console);
  const binding = bindingFor(options.console);
  const spec = consoleSpec.audio!;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  const decoded = decodeSound(bytes);
  const trimmed = trim(decoded.samples);
  const limited = limitLength(trimmed, maxLength);
  const features = analyzeSound(limited);
  const diagnostics: SfxResult["diagnostics"] = [];
  if (limited.length < trimmed.length) {
    diagnostics.push({
      code: "trimmed",
      severity: "warning",
      message: `source is ${(trimmed.length / decoded.sampleRate).toFixed(2)}s; kept the first ${maxLength}s`,
    });
  }

  const fit = binding.fitRate(options.rateHz ?? SFX_RATE_HZ);
  const rate = fit.rate;
  const tickHz = rate.num / rate.den;
  const ticks = Math.max(1, Math.round(features.durationSeconds * tickHz));

  const noiseIndex = spec.channels.findIndex((channel) => channel.kind === "noise");
  const pitchedIndex = spec.channels.findIndex((channel) => channel.pitch !== undefined);
  const portfolio = gesturesFor(features.soundClass, noiseIndex >= 0);

  // The source is described twice: once properly, for reporting and for the
  // class gate, and once at the scoring resolution so candidates are compared
  // against something measured the same way they are.
  const scoringTarget = analyzeSound(resample(limited, decoded.sampleRate, SCORING_RATE), {
    sampleRate: SCORING_RATE,
    frameSize: SCORING_FRAME,
    hop: SCORING_HOP,
  });

  const seed = seedParams({
    ticks,
    startHz: features.startF0,
    endHz: features.endF0,
    decay: decayExponent(features),
    brightness: meanOf(features.brightness),
  });

  return {
    consoleSpec,
    spec,
    binding,
    features,
    diagnostics,
    fit,
    noiseIndex,
    pitchedIndex,
    portfolio,
    scoringTarget,
    seed,
  };
}

/** What one gesture needs to know, and all of it structured-cloneable. */
export interface GestureJob {
  readonly source: Uint8Array;
  readonly options: SfxOptions;
  /** Which gesture of the source's own portfolio to fit — an id, since the family is derived. */
  readonly gesture: string;
}

/** What one gesture's fit produced. */
export interface GestureOutcome {
  readonly score: SfxCandidateScore;
  /** `null` when the fit came out non-compliant, which is when nothing scored it. */
  readonly script: ChipScript | null;
}

/**
 * Fit one gesture family to a sound and judge it — the engine's unit of parallel
 * work in this domain, and the counterpart of the image path's `runCandidate`.
 *
 * Takes the source bytes rather than the analysis for the same reason: what
 * crosses a thread has to be data, and re-deriving the analysis behind a memo is
 * cheaper than shipping it.
 */
export function runGesture(job: GestureJob): GestureOutcome {
  const derived = prologue(job.source, job.options);
  const gesture = derived.portfolio.find((one) => one.id === job.gesture);
  if (!gesture) {
    throw new SfxError("E_UNKNOWN_STRATEGY", `no gesture named '${job.gesture}' in this portfolio`);
  }
  const channelIndex = gesture.noise ? derived.noiseIndex : derived.pitchedIndex;
  const refined = refine(
    gesture,
    derived.seed,
    derived.spec,
    derived.binding,
    channelIndex,
    derived.fit,
    derived.scoringTarget,
    derived.features,
    job.options,
  );
  const script = buildScript(
    gesture,
    refined.params,
    derived.spec,
    derived.binding,
    channelIndex,
    derived.fit,
  );
  const inspection = inspectScript(script);
  if (!inspection.compliant) {
    return {
      score: {
        id: gesture.id,
        summary: gesture.summary,
        aggregate: 0,
        metrics: [],
        disqualified: { reason: inspection.violations[0]?.message ?? "not compliant" },
      },
      script: null,
    };
  }
  return {
    score: {
      id: gesture.id,
      summary: gesture.summary,
      aggregate: refined.score,
      metrics: refined.metrics,
    },
    script,
  };
}

/** The gesture job, as an executor sees it. */
export const gestureJob = defineJob<GestureJob, GestureOutcome>("audio.sfx.gesture", runGesture);

/** Fit gestures here, in order — the default, and the reference answer. */
const inline: Executor = inlineExecutor(jobHandlers([gestureJob]));

/**
 * Demake a sound file into a chip effect.
 *
 * `async` because the gesture families are independent and may be fitted on
 * other threads (doc 18 §The tournament); with no `executor` they are fitted
 * here, in order, for the same bytes.
 */
export async function demakeSfx(bytes: Uint8Array, options: SfxOptions): Promise<SfxResult> {
  const derived = prologue(bytes, options);
  const { consoleSpec, spec, features, diagnostics, noiseIndex, pitchedIndex } = derived;

  let portfolio = derived.portfolio;
  if (options.strategy) {
    portfolio = portfolio.filter((gesture) => gesture.id === options.strategy);
    if (portfolio.length === 0) {
      throw new SfxError(
        "E_UNKNOWN_STRATEGY",
        `no gesture named '${options.strategy}' is eligible for a ${features.soundClass} source`,
      );
    }
  } else if ((options.effort ?? "default") === "fast") {
    portfolio = portfolio.slice(0, 1);
  }
  // A gesture whose channel this console does not have cannot be fitted at all,
  // so it is dropped before the fan-out rather than occupying a lane to say so.
  portfolio = portfolio.filter((gesture) => (gesture.noise ? noiseIndex : pitchedIndex) >= 0);
  if (portfolio.length === 0) {
    throw new SfxError(
      "E_NO_ELIGIBLE_GESTURE",
      `nothing can represent a ${features.soundClass} source on ${consoleSpec.name}`,
    );
  }

  const executor = options.executor ?? inline;
  // The executor is the thing carrying the jobs; it cannot also be inside one.
  const { executor: carrier, ...portable } = options;
  void carrier;
  const jobs = portfolio.map((gesture) =>
    gestureJob.job({ source: bytes, options: portable, gesture: gesture.id }),
  );
  const outcomes = await executor(jobs);
  if (outcomes.length !== jobs.length) {
    throw new SfxError(
      "E_INTERNAL",
      `the executor answered ${outcomes.length} of ${jobs.length} gestures`,
    );
  }

  const scored: SfxCandidateScore[] = [];
  let best: { gesture: Gesture; script: ChipScript; score: number } | undefined;
  // Walked in portfolio order, not arrival order: ties break by the fixed order
  // of the families, so the winner cannot depend on how many lanes ran them.
  for (let index = 0; index < portfolio.length; index += 1) {
    const gesture = portfolio[index]!;
    const outcome = unwrap<GestureOutcome>(outcomes[index]!);
    scored.push(outcome.score);
    if (outcome.script === null) continue;
    if (!best || outcome.score.aggregate > best.score) {
      best = { gesture, script: outcome.script, score: outcome.score.aggregate };
    }
  }

  if (!best) {
    throw new SfxError("E_NO_VALID_CANDIDATE", "every gesture was disqualified");
  }

  const channelIndex = best.gesture.noise ? noiseIndex : pitchedIndex;
  const channel = spec.channels[channelIndex]!;
  const artifact = encodeArtifact(best.script, consoleSpec.name, options.title);

  return {
    script: best.script,
    artifact,
    features,
    soundClass: features.soundClass,
    placement: {
      channelId: channel.id,
      // A louder, sharper effect is more likely to be the one the player is
      // waiting to hear, so it outranks a quiet tick when both want a channel.
      priority: Math.round(
        features.envelope[0] !== undefined ? 5 + 4 * peakOf(features.envelope) : 5,
      ),
      prefers: spec.channels
        .filter((candidate) => candidate.kind === channel.kind)
        .map((candidate) => candidate.id),
    },
    tournament: { winner: best.gesture.id, candidates: scored },
    diagnostics,
  };
}

/**
 * Coordinate descent over the gesture's parameters.
 *
 * Deterministic, and bounded: each parameter is swept over the *hardware's* own
 * range, improvements are kept, and the pass repeats to a fixed point with a
 * fixed cap. No randomness, so two runs agree exactly (doc 02 §Determinism).
 */
function refine(
  gesture: Gesture,
  seed: GestureParams,
  spec: AudioSpec,
  binding: ChipBinding,
  channelIndex: number,
  clock: DriverRateFit,
  target: SoundFeatures,
  pitchTarget: SoundFeatures,
  options: SfxOptions,
): { params: GestureParams; score: number; metrics: { id: string; score: number }[] } {
  const passes = (options.effort ?? "default") === "max" ? 3 : 1;
  let current = seed;
  let evaluation = evaluate(
    gesture,
    current,
    spec,
    binding,
    channelIndex,
    clock,
    target,
    pitchTarget,
  );

  // Only the parameters this gesture reads: sweeping a duty cycle on a noise
  // burst is dozens of renders that cannot change the answer.
  const sweeps: { key: keyof GestureParams; values: number[] }[] = [
    { key: "decay", values: [0, 0.5, 1, 1.5, 2, 3, 5] },
  ];
  if (gesture.noise) {
    sweeps.push({ key: "noisePeriod", values: [0, 8, 16, 24, 32, 40, 48, 56] });
    if (gesture.id === "pitched-noise") {
      sweeps.push({ key: "sweepCents", values: sweepCandidates(seed.sweepCents) });
    }
  } else {
    sweeps.push({ key: "duty", values: [0, 1, 2, 3] });
    sweeps.push({ key: "sweepCents", values: sweepCandidates(seed.sweepCents) });
    sweeps.push({ key: "startCents", values: pitchCandidates(seed.startCents) });
  }

  for (let pass = 0; pass < passes; pass += 1) {
    let improved = false;
    for (const sweep of sweeps) {
      for (const value of sweep.values) {
        if (current[sweep.key] === value) continue;
        const candidate = { ...current, [sweep.key]: value } as GestureParams;
        const trial = evaluate(
          gesture,
          candidate,
          spec,
          binding,
          channelIndex,
          clock,
          target,
          pitchTarget,
        );
        if (trial.score > evaluation.score + 1e-9) {
          current = candidate;
          evaluation = trial;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return { params: current, score: evaluation.score, metrics: evaluation.metrics };
}

function sweepCandidates(seed: number): number[] {
  const base = [0, 600, 1200, 2400, -600, -1200, -2400];
  return seed === 0 ? base : [seed, ...base];
}

function pitchCandidates(seed: number): number[] {
  return [seed, seed - 1200, seed + 1200, 4800, 6000, 7200, 8400];
}

/**
 * Score one parameter set by rendering it and comparing features.
 *
 * The comparison is deliberately about *shape*: envelope contour, pitch contour
 * over voiced frames, and noisiness over time. Absolute spectral distance would
 * reward a candidate that matched the source's timbre while losing its gesture,
 * which is the wrong trade for a sound effect (doc 18 §The objective).
 */
function evaluate(
  gesture: Gesture,
  params: GestureParams,
  spec: AudioSpec,
  binding: ChipBinding,
  channelIndex: number,
  clock: DriverRateFit,
  target: SoundFeatures,
  pitchTarget: SoundFeatures,
): { score: number; metrics: { id: string; score: number }[] } {
  const lane = gesture.frames(params);
  const script = buildScript(gesture, params, spec, binding, channelIndex, clock);
  // Scoring renders at a lower rate with a coarser hop. The shapes being
  // compared — envelope, noisiness, brightness — survive that intact, and the
  // loop runs hundreds of times per effect; the winning candidate is then
  // rebuilt at full rate for the artifact.
  const pcm = render(script, { sampleRate: SCORING_RATE, tailSeconds: 0.05 });
  const rendered = analyzeSound(pcm.channels[0]!, {
    sampleRate: SCORING_RATE,
    frameSize: SCORING_FRAME,
    hop: SCORING_HOP,
  });

  const length = Math.max(8, Math.min(target.envelope.length, 64));
  const envelopeScore = half(
    correlation(resize(target.envelope, length), resize(rendered.envelope, length)),
  );
  // Pitch is scored against what the hardware will *play* rather than against a
  // pitch tracker's reading of our own square wave. The lattice snap is
  // deterministic and already applied here, so this is the frequency the chip
  // emits — exact, free, and without the octave errors autocorrelation makes on
  // a narrow duty cycle. Timbre and envelope still come from the render, where
  // there is no substitute for hearing what the chip did.
  const intended = spec.channels[channelIndex]!.pitch
    ? lane.map((frame) =>
        frame.on ? snapPitch(spec.channels[channelIndex]!.pitch!, frame.hz).hz : 0,
      )
    : [];
  // Pitch is compared against the source's *full-rate* track. The coarse
  // scoring analysis exists to make render-based metrics cheap; a pitch track is
  // measured once from the source and does not need re-measuring per candidate,
  // and measuring it coarsely costs an octave error that can invert a gesture.
  const pitchScore = pitchContour(pitchTarget, intended, Math.max(8, pitchTarget.f0.length));
  // Noisiness and brightness are compared as *levels*, not shapes. Both tracks
  // are near-constant over a short effect, and correlating two flat series says
  // nothing — which is how a pure tone came to out-score a drum on a noise
  // burst. Envelope and pitch stay correlations, because those genuinely are
  // shapes.
  const noiseScore =
    1 - Math.min(1, Math.abs(meanOf(target.noisiness) - meanOf(rendered.noisiness)));
  const brightScore = octaveAgreement(meanOf(target.brightness), meanOf(rendered.brightness));
  const durationScore =
    target.durationSeconds === 0
      ? 0
      : 1 -
        Math.min(
          1,
          Math.abs(rendered.durationSeconds - target.durationSeconds) / target.durationSeconds,
        );
  // The class gate again, now against what the candidate actually produced: a
  // rendered sound in the wrong class scores zero however well it correlates.
  const classScore = rendered.soundClass === target.soundClass ? 1 : 0.25;

  const metrics: { id: string; score: number; weight: number }[] = [
    { id: "envelope", score: envelopeScore, weight: 0.28 },
    { id: "noisiness", score: noiseScore, weight: 0.16 },
    { id: "brightness", score: brightScore, weight: 0.1 },
    { id: "duration", score: durationScore, weight: 0.11 },
    { id: "class", score: classScore, weight: 0.11 },
  ];
  // Pitch applies only to a pitched channel. A noise burst has no pitch to get
  // right, so the metric is *omitted* and the remaining weights renormalized —
  // scoring it a neutral 0.5 instead would hand every pitched candidate a lead
  // no drum could ever make up, which is how a snare ends up as a beep.
  // Pitch's weight scales with how pitched the source actually is. A noise
  // burst has 30% voiced frames of mostly spurious estimates, and a candidate
  // that matches them should not be able to win on it.
  if (intended.length > 0 && pitchTarget.voicedFraction > 0.2) {
    metrics.splice(1, 0, {
      id: "pitch-contour",
      score: pitchScore,
      weight: 0.24 * pitchTarget.voicedFraction,
    });
  }
  let score = 0;
  let total = 0;
  for (const metric of metrics) {
    score += metric.score * metric.weight;
    total += metric.weight;
  }
  return {
    score: total === 0 ? 0 : score / total,
    metrics: metrics.map(({ id, score: value }) => ({ id, score: value })),
  };
}

/** Correlation is in [-1, 1]; scores are in [0, 1]. */
function half(value: number): number {
  return (value + 1) / 2;
}

/**
 * How well the candidate's pitch moves the way the source's did.
 *
 * Compared over the frames where the *source* was voiced, because a candidate's
 * own unvoiced frames say nothing about whether it got the gesture right. This
 * is the metric that distinguishes a rising sweep from a falling one, and
 * without it the other four are perfectly happy to accept either — brightness
 * tracks pitch only loosely once a square wave's harmonics are in play.
 */
function pitchContour(target: SoundFeatures, intended: readonly number[], length: number): number {
  if (intended.length === 0) return 0.5;
  const wanted = resize(target.f0, length);
  const got = resize(intended, length);
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < length; i += 1) {
    if (wanted[i]! <= 0) continue;
    a.push(wanted[i]!);
    b.push(got[i]!);
  }
  // Nothing pitched to compare: neither reward nor punish.
  if (a.length < 3) return 0.5;

  // Correlation alone discriminates weakly here, because a chip's square wave
  // gives a noisy pitch track and both directions correlate about as badly.
  // Trend — where the pitch ended up relative to where it started, in octaves —
  // is the thing the sweep families actually differ in, so it is measured
  // directly rather than hoped for.
  const shape = half(correlation(a, b));
  const difference = Math.abs(trend(a) - trend(b));
  const direction = 1 - Math.min(1, difference / 2);
  return shape * 0.4 + direction * 0.6;
}

/** Pitch travel from the first third to the last, in octaves. */
function trend(series: readonly number[]): number {
  const third = Math.max(1, Math.floor(series.length / 3));
  const mean = (from: number, to: number): number => {
    let sum = 0;
    let count = 0;
    for (let i = from; i < to; i += 1) {
      if (series[i]! <= 0) continue;
      sum += series[i]!;
      count += 1;
    }
    return count === 0 ? 0 : sum / count;
  };
  const start = mean(0, third);
  const end = mean(series.length - third, series.length);
  if (start <= 0 || end <= 0) return 0;
  return math.log(end / start) / 0.6931471805599453;
}

/**
 * The effect as the file this console's schedules are written in.
 *
 * `arrange`'s `encodeArtifact` one domain over, and it has the same three cases
 * for the same reasons (`encode/spc.ts` §artifactFormat). The Game Boy Advance is
 * the one that is not a register log at all: half of its voices are a *software
 * mixer*, so a VGM carrying only the four Game Boy channels would be a schedule
 * with the rest of the sound missing, presented as the schedule.
 */
function encodeArtifact(script: ChipScript, system: string, title: string | undefined): Uint8Array {
  switch (artifactFormat(script.chips)) {
    case "spc":
      return encodeSpc(script, { ...(title ? { title } : {}), game: system });
    case "wav":
      return encodeWav(render(script));
    default:
      return encodeVgm(script, { ...(title ? { title } : {}), system });
  }
}

/**
 * A bound write, narrowed to what a schedule holds — **including which chip**.
 *
 * A console may have two, and on one of them they are not even the same kind of
 * device: the Game Boy Advance's second is a software mixer whose register five
 * is a voice's right level, where the Game Boy channels' register five is a
 * frequency byte. So a write that lost its chip is a write to whichever device
 * the driver guesses, and on the Mega Drive it is a tone write sent to the FM
 * bus. It was dropped here for as long as this file existed, and it went unseen
 * because the one console with two chips places its effects on the *first*
 * pitched channel, which is chip zero — a wrong answer that happens to equal the
 * right one.
 */
function keepChip(write: { reg: number; value: number; chip?: number }): {
  reg: number;
  value: number;
  chip?: number;
} {
  return write.chip === undefined
    ? { reg: write.reg, value: write.value }
    : {
        reg: write.reg,
        value: write.value,
        chip: write.chip,
      };
}

/** Wrap a gesture's frames into a complete, single-channel script. */
function buildScript(
  gesture: Gesture,
  params: GestureParams,
  spec: AudioSpec,
  binding: ChipBinding,
  channelIndex: number,
  clock: DriverRateFit,
): ChipScript {
  const lane = gesture.frames(params);
  const ticks: TickWrites[] = [];
  let previous: ChannelFrame[] | undefined;
  const init = binding.init();

  for (let tick = 0; tick < lane.length; tick += 1) {
    const frames = silentFrames(spec);
    frames[channelIndex] = lane[tick]!;
    const bound = binding.encode(frames, previous);
    const writes = tick === 0 ? [...init, ...bound] : bound;
    ticks.push({ writes: writes.map(keepChip) });
    previous = frames;
  }
  // A closing silent tick, so the effect releases rather than stopping dead with
  // the channel still driving a level.
  const off = silentFrames(spec);
  ticks.push({ writes: binding.encode(off, previous).map(keepChip) });

  const script: ChipScript = {
    console: binding.console,
    chips: binding.chips,
    driver: {
      rate: clock.rate,
      source: clock.source,
      // The reload is carried, not just the rate it produces: a ROM has to
      // program a register, and re-deriving one from a rational would be a
      // second timing fit that could disagree with the first.
      ...(clock.divisor === undefined ? {} : { divisor: clock.divisor }),
    },
    ticks,
    // An effect is a one-shot: -1 says so, and every player honours it.
    loopTick: -1,
    channels: [
      {
        channelId: spec.channels[channelIndex]!.id,
        partId: gesture.id,
        startTick: 0,
        endTick: ticks.length,
        treatment: "direct",
      },
    ],
    timing: {
      source: clock.source,
      ...(clock.divisor === undefined ? {} : { divisor: clock.divisor }),
      requestedBpm: 0,
      achievedBpm: 0,
      ppmError: 0,
      rowsPerBeat: 0,
      maxOnsetDeviationMs: (clock.rate.den / clock.rate.num) * 500,
      accumulates: false,
    },
    budgets: { writes: 0, peakWritesPerTick: 0, writeBudget: spec.driver.writesPerTick },
  };
  script.budgets.writes = countWrites(script);
  script.budgets.peakWritesPerTick = peakWritesPerTick(script);
  return script;
}

/** Turn a measured envelope into the decay exponent the gestures take. */
function decayExponent(features: SoundFeatures): number {
  const envelope = features.envelope;
  if (envelope.length < 4) return 1;
  // Where the envelope crosses half its peak tells us how sharp the fall is:
  // early means a pluck, late means a swell.
  let halfIndex = envelope.length - 1;
  for (let i = 0; i < envelope.length; i += 1) {
    if (envelope[i]! < 0.5) {
      halfIndex = i;
      break;
    }
  }
  const fraction = halfIndex / envelope.length;
  if (fraction <= 0.05) return 5;
  if (fraction >= 0.9) return 0;
  // A power curve reaching 0.5 at `fraction` has exponent log(0.5)/log(1-f).
  return Math.min(6, Math.max(0.2, 0.6931471805599453 / -logOf(1 - fraction)));
}

function logOf(value: number): number {
  return value <= 0 ? -1e-6 : math.log(value);
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** How close two frequencies are, in octaves: 1 is identical, 0 is two apart. */
function octaveAgreement(a: number, b: number): number {
  if (a <= 0 || b <= 0) return a === b ? 1 : 0;
  const octaves = Math.abs(math.log(a / b) / 0.6931471805599453);
  return 1 - Math.min(1, octaves / 2);
}

function peakOf(values: readonly number[]): number {
  let peak = 0;
  for (const value of values) if (value > peak) peak = value;
  return peak;
}
