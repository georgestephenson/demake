/**
 * Deterministic DSP (doc 16 §Determinism engineering).
 *
 * Audio analysis is where determinism breaks first: an FFT seeded with
 * `Math.cos` returns different low bits in different engines, and every metric
 * downstream inherits it. So every transcendental here comes from the engine's
 * own kernels, every buffer is a typed array, and nothing depends on a platform
 * primitive — the same discipline the colour pipeline lives under, applied where
 * it is easier to violate.
 *
 * The set is deliberately small: enough to describe a sound effect (envelope,
 * pitch, brightness, noisiness) and nothing speculative.
 */

import { math } from "@demake/core";

/** The canonical analysis rate; every decoded input is resampled to it. */
export const ANALYSIS_RATE = 48000;

const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;

/**
 * Resample with a windowed-sinc kernel.
 *
 * Ours rather than the platform's for the reason doc 02 gives about image
 * codecs: a browser's `AudioContext` resamples on its own terms, so a preview
 * built on it would differ from Node's in the low bits of every sample.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const length = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(length);
  // Sixteen taps, and the cutoff drops when downsampling so the kernel does the
  // anti-aliasing rather than leaving it to luck.
  const taps = 16;
  const cutoff = ratio < 1 ? ratio : 1;
  for (let i = 0; i < length; i += 1) {
    const centre = i / ratio;
    const base = Math.floor(centre);
    let sum = 0;
    let weightSum = 0;
    for (let k = -taps; k <= taps; k += 1) {
      const index = base + k;
      if (index < 0 || index >= input.length) continue;
      const x = (index - centre) * cutoff;
      const weight = sinc(x) * blackman((index - centre) / taps);
      sum += input[index]! * weight;
      weightSum += weight;
    }
    out[i] = weightSum === 0 ? 0 : sum / weightSum;
  }
  return out;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const t = PI * x;
  return math.sin(t) / t;
}

function blackman(t: number): number {
  if (t <= -1 || t >= 1) return 0;
  const phase = PI * (t + 1);
  return 0.42 - 0.5 * math.cos(phase) + 0.08 * math.cos(2 * phase);
}

/** A Hann window of `size` samples, precomputed once per size. */
export function hann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * math.cos((TWO_PI * i) / size);
  }
  return window;
}

/**
 * In-place radix-2 FFT.
 *
 * Twiddles come from the deterministic sine kernel, computed per stage rather
 * than from a recurrence — a recurrence accumulates error differently depending
 * on how the compiler orders it, which is exactly the class of difference this
 * package exists to avoid.
 */
export function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error("fft: size must be a power of two");

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]!;
      real[i] = real[j]!;
      real[j] = tr;
      const ti = imag[i]!;
      imag[i] = imag[j]!;
      imag[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = -TWO_PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const phase = angle * k;
        const wr = math.cos(phase);
        const wi = math.sin(phase);
        const ur = real[i + k]!;
        const ui = imag[i + k]!;
        const vr = real[i + k + len / 2]! * wr - imag[i + k + len / 2]! * wi;
        const vi = real[i + k + len / 2]! * wi + imag[i + k + len / 2]! * wr;
        real[i + k] = ur + vr;
        imag[i + k] = ui + vi;
        real[i + k + len / 2] = ur - vr;
        imag[i + k + len / 2] = ui - vi;
      }
    }
  }
}

/** Magnitude spectrum of one windowed frame. */
export function spectrum(frame: Float32Array, window: Float32Array): Float32Array {
  const size = frame.length;
  const real = new Float32Array(size);
  const imag = new Float32Array(size);
  for (let i = 0; i < size; i += 1) real[i] = frame[i]! * window[i]!;
  fft(real, imag);
  const half = size >> 1;
  const magnitude = new Float32Array(half);
  for (let i = 0; i < half; i += 1) {
    magnitude[i] = Math.sqrt(real[i]! * real[i]! + imag[i]! * imag[i]!);
  }
  return magnitude;
}

/** Root-mean-square level of a span. */
export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / (to - from));
}

/** Per-frame RMS envelope. */
export function envelope(samples: Float32Array, frameSize: number, hop: number): Float32Array {
  const frames = Math.max(1, Math.floor((samples.length - frameSize) / hop) + 1);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = rms(samples, i * hop, Math.min(i * hop + frameSize, samples.length));
  }
  return out;
}

/**
 * Spectral centroid, in Hz — the standard proxy for brightness.
 *
 * Brightness is what a duty cycle or a noise period has to match, so this is the
 * feature that decides most timbre choices in the sound demaker.
 */
export function centroid(magnitude: Float32Array, sampleRate: number, size: number): number {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < magnitude.length; i += 1) {
    const value = magnitude[i]!;
    weighted += ((i * sampleRate) / size) * value;
    total += value;
  }
  return total === 0 ? 0 : weighted / total;
}

/**
 * Spectral flatness, 0–1 — the tonal-versus-noisy discriminator.
 *
 * The geometric mean over the arithmetic mean: a sine is near zero, white noise
 * is near one. This is what separates a chime from a hit, and it is the feature
 * the class gate leans on hardest.
 */
export function flatness(magnitude: Float32Array): number {
  let logSum = 0;
  let sum = 0;
  let count = 0;
  for (let i = 1; i < magnitude.length; i += 1) {
    const value = magnitude[i]! + 1e-10;
    logSum += math.log(value);
    sum += value;
    count += 1;
  }
  if (count === 0 || sum === 0) return 0;
  const geometric = math.exp(logSum / count);
  return geometric / (sum / count);
}

/**
 * Fundamental frequency by normalized autocorrelation.
 *
 * Autocorrelation rather than an FFT peak because a sound effect's pitch is
 * often a fast sweep, and a short window resolves time better than frequency.
 * Returns `0` when nothing is convincingly periodic — an honest "unvoiced"
 * rather than a confident wrong answer.
 */
export function detectF0(
  samples: Float32Array,
  sampleRate: number,
  minHz = 50,
  maxHz = 4000,
): number {
  // Autocorrelation costs lags x samples, which at 48 kHz is a million
  // multiplies per frame and dominates every profile the sound demaker has.
  // Pitch below 4 kHz survives an 8 kHz decimation intact, so the search runs
  // there instead: the same answer for a fortieth of the work.
  const factor = Math.max(1, Math.floor(sampleRate / 8000));
  const decimated = decimate(samples, factor);
  const rate = sampleRate / factor;

  const minLag = Math.max(2, Math.floor(rate / maxHz));
  const maxLag = Math.min(Math.floor(rate / minHz), decimated.length - 1);
  if (maxLag <= minLag) return 0;

  let bestLag = 0;
  let bestScore = 0;
  let energy = 0;
  for (let i = 0; i < decimated.length; i += 1) energy += decimated[i]! * decimated[i]!;
  if (energy === 0) return 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    let normal = 0;
    for (let i = 0; i + lag < decimated.length; i += 1) {
      correlation += decimated[i]! * decimated[i + lag]!;
      normal += decimated[i + lag]! * decimated[i + lag]!;
    }
    if (normal === 0) continue;
    const score = correlation / Math.sqrt(energy * normal);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // Below this the "period" is as likely to be noise structure as pitch, and a
  // confident wrong answer is worse than an honest "unvoiced".
  if (bestScore < 0.3 || bestLag === 0) return 0;
  return rate / bestLag;
}

/** Box-average decimation: cheap, and enough anti-aliasing for a pitch search. */
function decimate(samples: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return samples;
  const length = Math.floor(samples.length / factor);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (let k = 0; k < factor; k += 1) sum += samples[i * factor + k]!;
    out[i] = sum / factor;
  }
  return out;
}

/** Pearson correlation of two equal-length series, in [-1, 1]. */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i]!;
    meanB += b[i]!;
  }
  meanA /= n;
  meanB /= n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

/** Resample a series to `length` points by linear interpolation. */
export function resize(series: readonly number[], length: number): number[] {
  if (series.length === 0) return new Array<number>(length).fill(0);
  if (series.length === length) return [...series];
  const out = new Array<number>(length);
  for (let i = 0; i < length; i += 1) {
    const position = (i * (series.length - 1)) / Math.max(length - 1, 1);
    const low = Math.floor(position);
    const high = Math.min(low + 1, series.length - 1);
    const fraction = position - low;
    out[i] = series[low]! * (1 - fraction) + series[high]! * fraction;
  }
  return out;
}
