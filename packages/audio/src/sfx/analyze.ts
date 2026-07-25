/**
 * Sound analysis (doc 18 §Stage 1).
 *
 * Everything downstream is fitted against these tracks, so they *are* the
 * representation of the source. Five of them, and each exists because it decides
 * something: the envelope decides whether a thing reads as a hit or a chime, the
 * f0 track gives a gesture its shape, noisiness separates a snare from a bell,
 * brightness maps onto duty and noise period, and duration is trivially
 * important and trivially easy to lose.
 */

import { centroid, detectF0, flatness, hann, rms, spectrum, ANALYSIS_RATE } from "../dsp.js";

/** The coarse sonic identity a candidate must match to be eligible at all. */
export type SoundClass = "tonal" | "noisy" | "percussive" | "swept" | "vocal";

export interface SoundFeatures {
  /** Analysis frames per second. */
  frameRate: number;
  /** Per-frame RMS, normalized so the peak is 1. */
  envelope: number[];
  /** Per-frame fundamental in Hz; `0` where unvoiced. */
  f0: number[];
  /** Per-frame spectral flatness, 0 (tonal) to 1 (noise). */
  noisiness: number[];
  /** Per-frame spectral centroid in Hz. */
  brightness: number[];
  durationSeconds: number;
  /** Seconds from the start to the peak — the attack. */
  attackSeconds: number;
  /** Fraction of frames with a confident pitch. */
  voicedFraction: number;
  /** Mean pitch over voiced frames, in Hz; `0` when unvoiced throughout. */
  meanF0: number;
  /** Pitch at the start and end of the voiced span, for sweep fitting. */
  startF0: number;
  endF0: number;
  soundClass: SoundClass;
}

const FRAME_SIZE = 1024;
const HOP = 256;

/**
 * Analysis knobs.
 *
 * The defaults describe a source. The fitting loop overrides them to score a
 * candidate more cheaply: it renders at a lower rate with a coarser hop, because
 * the shapes it compares survive that and the loop runs hundreds of times.
 */
export interface AnalyzeSoundOptions {
  sampleRate?: number;
  frameSize?: number;
  hop?: number;
}

/** Trim leading and trailing silence, keeping the salient event. */
export function trim(samples: Float32Array, threshold = 0.005): Float32Array {
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]!) < threshold) start += 1;
  while (end > start && Math.abs(samples[end - 1]!) < threshold) end -= 1;
  if (end - start < 16) return samples;
  return samples.subarray(start, end);
}

/** Cut a sound to at most `seconds`, keeping the attack and the decay's start. */
export function limitLength(samples: Float32Array, seconds: number): Float32Array {
  const limit = Math.floor(seconds * ANALYSIS_RATE);
  return samples.length <= limit ? samples : samples.subarray(0, limit);
}

/** Describe a sound. */
export function analyzeSound(
  samples: Float32Array,
  options: AnalyzeSoundOptions = {},
): SoundFeatures {
  const sampleRate = options.sampleRate ?? ANALYSIS_RATE;
  const frameSize = options.frameSize ?? FRAME_SIZE;
  const hop = options.hop ?? HOP;
  const window = hann(frameSize);
  const frames = Math.max(1, Math.floor((samples.length - frameSize) / hop) + 1);
  const frameRate = sampleRate / hop;

  const envelope: number[] = [];
  const f0: number[] = [];
  const noisiness: number[] = [];
  const brightness: number[] = [];

  for (let i = 0; i < frames; i += 1) {
    const from = i * hop;
    const to = Math.min(from + frameSize, samples.length);
    const frame = new Float32Array(frameSize);
    frame.set(samples.subarray(from, to));
    const magnitude = spectrum(frame, window);
    envelope.push(rms(samples, from, to));
    f0.push(detectF0(frame.subarray(0, to - from), sampleRate));
    noisiness.push(flatness(magnitude));
    brightness.push(centroid(magnitude, sampleRate, frameSize));
  }

  let peak = 0;
  let peakIndex = 0;
  for (let i = 0; i < envelope.length; i += 1) {
    if (envelope[i]! > peak) {
      peak = envelope[i]!;
      peakIndex = i;
    }
  }
  const normalized = peak === 0 ? envelope : envelope.map((value) => value / peak);

  const voiced = f0.filter((value) => value > 0);
  const voicedFraction = f0.length === 0 ? 0 : voiced.length / f0.length;
  const meanF0 = voiced.length === 0 ? 0 : voiced.reduce((a, b) => a + b, 0) / voiced.length;
  const startF0 = voiced[0] ?? 0;
  const endF0 = voiced[voiced.length - 1] ?? 0;

  const features: Omit<SoundFeatures, "soundClass"> = {
    frameRate,
    envelope: normalized,
    f0,
    noisiness,
    brightness,
    durationSeconds: samples.length / sampleRate,
    attackSeconds: peakIndex / frameRate,
    voicedFraction,
    meanF0,
    startF0,
    endF0,
  };
  return { ...features, soundClass: classify(features) };
}

/**
 * The coarse class, which gates the tournament (doc 18 §The objective).
 *
 * A candidate that lands in the wrong class is disqualified however well it
 * scores, because "closest by some distance" is exactly how an explosion comes
 * back as a beep — a beep being the nearest single sine to almost anything.
 */
function classify(features: Omit<SoundFeatures, "soundClass">): SoundClass {
  const meanNoisiness =
    features.noisiness.length === 0
      ? 0
      : features.noisiness.reduce((a, b) => a + b, 0) / features.noisiness.length;

  // Noisiness decides the family before pitch decides the sub-type, and the
  // order matters: a pitch tracker will happily report a moving "fundamental"
  // for a noise burst, and trusting it first classifies an explosion as a sweep.
  if (meanNoisiness > 0.35) {
    // Short and noisy is a hit; long and noisy is texture.
    return features.durationSeconds < 0.35 ? "percussive" : "noisy";
  }
  // A confident pitch that moves a long way is a sweep.
  if (features.voicedFraction > 0.4 && features.startF0 > 0 && features.endF0 > 0) {
    const ratio = features.endF0 / features.startF0;
    if (ratio > 1.5 || ratio < 0.67) return "swept";
  }
  if (features.voicedFraction > 0.5) {
    // A voice is pitched but far from pure: formants keep the flatness up.
    return meanNoisiness > 0.15 ? "vocal" : "tonal";
  }
  return features.durationSeconds < 0.25 ? "percussive" : "noisy";
}
