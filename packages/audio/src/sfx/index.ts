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

import { getConsole, math, type AudioSpec } from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import { silentFrames, type ChipBinding } from "../binding/types.js";
import type { ChannelFrame, ChipScript, TickWrites } from "../chipscript.js";
import { countWrites, peakWritesPerTick } from "../chipscript.js";
import { correlation, resample, resize } from "../dsp.js";
import { encodeVgm } from "../encode/vgm.js";
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
const SFX_RATE_HZ = 240;
const DEFAULT_MAX_LENGTH = 5;

/** The cheap analysis the fitting loop scores against (doc 18 §Stage 3). */
const SCORING_RATE = 16000;
const SCORING_FRAME = 512;
const SCORING_HOP = 256;

/** Demake a sound file into a chip effect. */
export function demakeSfx(bytes: Uint8Array, options: SfxOptions): SfxResult {
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

  const fit = binding.fitRate(SFX_RATE_HZ);
  const rate = fit.rate;
  const tickHz = rate.num / rate.den;
  const ticks = Math.max(1, Math.round(features.durationSeconds * tickHz));

  const noiseIndex = spec.channels.findIndex((channel) => channel.kind === "noise");
  const pitchedIndex = spec.channels.findIndex((channel) => channel.pitch !== undefined);
  let portfolio = gesturesFor(features.soundClass, noiseIndex >= 0);
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
  if (portfolio.length === 0) {
    throw new SfxError(
      "E_NO_ELIGIBLE_GESTURE",
      `nothing can represent a ${features.soundClass} source on ${consoleSpec.name}`,
    );
  }

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

  const scored: SfxCandidateScore[] = [];
  let best:
    { gesture: Gesture; params: GestureParams; script: ChipScript; score: number } | undefined;

  for (const gesture of portfolio) {
    const channelIndex = gesture.noise ? noiseIndex : pitchedIndex;
    if (channelIndex < 0) continue;
    const refined = refine(
      gesture,
      seed,
      spec,
      binding,
      channelIndex,
      rate,
      scoringTarget,
      options,
    );
    const script = buildScript(gesture, refined.params, spec, binding, channelIndex, rate);
    const inspection = inspectScript(script);
    if (!inspection.compliant) {
      scored.push({
        id: gesture.id,
        summary: gesture.summary,
        aggregate: 0,
        metrics: [],
        disqualified: { reason: inspection.violations[0]?.message ?? "not compliant" },
      });
      continue;
    }
    scored.push({
      id: gesture.id,
      summary: gesture.summary,
      aggregate: refined.score,
      metrics: refined.metrics,
    });
    if (!best || refined.score > best.score) {
      best = { gesture, params: refined.params, script, score: refined.score };
    }
  }

  if (!best) {
    throw new SfxError("E_NO_VALID_CANDIDATE", "every gesture was disqualified");
  }

  const channelIndex = best.gesture.noise ? noiseIndex : pitchedIndex;
  const channel = spec.channels[channelIndex]!;
  const artifact = encodeVgm(best.script, {
    ...(options.title ? { title: options.title } : {}),
    system: consoleSpec.name,
  });

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
  rate: { num: number; den: number },
  features: SoundFeatures,
  options: SfxOptions,
): { params: GestureParams; score: number; metrics: { id: string; score: number }[] } {
  const passes = (options.effort ?? "default") === "max" ? 3 : 1;
  let current = seed;
  let evaluation = evaluate(gesture, current, spec, binding, channelIndex, rate, features);

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
        const trial = evaluate(gesture, candidate, spec, binding, channelIndex, rate, features);
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
  rate: { num: number; den: number },
  target: SoundFeatures,
): { score: number; metrics: { id: string; score: number }[] } {
  const script = buildScript(gesture, params, spec, binding, channelIndex, rate);
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
  const noiseScore = half(
    correlation(resize(target.noisiness, length), resize(rendered.noisiness, length)),
  );
  const brightScore = half(
    correlation(resize(target.brightness, length), resize(rendered.brightness, length)),
  );
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

  const metrics = [
    { id: "envelope", score: envelopeScore },
    { id: "noisiness", score: noiseScore },
    { id: "brightness", score: brightScore },
    { id: "duration", score: durationScore },
    { id: "class", score: classScore },
  ];
  const weights = [0.35, 0.2, 0.15, 0.15, 0.15];
  let score = 0;
  for (let i = 0; i < metrics.length; i += 1) score += metrics[i]!.score * weights[i]!;
  return { score, metrics };
}

/** Correlation is in [-1, 1]; scores are in [0, 1]. */
function half(value: number): number {
  return (value + 1) / 2;
}

/** Wrap a gesture's frames into a complete, single-channel script. */
function buildScript(
  gesture: Gesture,
  params: GestureParams,
  spec: AudioSpec,
  binding: ChipBinding,
  channelIndex: number,
  rate: { num: number; den: number },
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
    ticks.push({ writes: writes.map(({ reg, value }) => ({ reg, value })) });
    previous = frames;
  }
  // A closing silent tick, so the effect releases rather than stopping dead with
  // the channel still driving a level.
  const off = silentFrames(spec);
  ticks.push({
    writes: binding.encode(off, previous).map(({ reg, value }) => ({ reg, value })),
  });

  const script: ChipScript = {
    console: binding.console,
    chips: binding.chips,
    driver: { rate, source: "timer" },
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
      source: "timer",
      requestedBpm: 0,
      achievedBpm: 0,
      ppmError: 0,
      rowsPerBeat: 0,
      maxOnsetDeviationMs: (rate.den / rate.num) * 500,
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

function peakOf(values: readonly number[]): number {
  let peak = 0;
  for (const value of values) if (value > peak) peak = value;
  return peak;
}
