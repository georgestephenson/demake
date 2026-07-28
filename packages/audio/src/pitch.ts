/**
 * Pitch, and the error snapping it to hardware costs (doc 16 §The `AudioSpec`).
 *
 * The chip counterpart of the image path's colour lattice: a channel can only
 * produce the frequencies its divider can express, so every note moves, and how
 * far it moved is the number the judge cares about. Cents is the unit — a
 * hundredth of a semitone, comfortably below the ~5-cent discrimination
 * threshold — so the same measure covers a note detuned by rounding and a whole
 * track deliberately transposed.
 */

import { math, latticeMaxHz, latticeMinHz, type PitchLattice } from "@demake/core";

/** Cents of A4 = 440 Hz, in the score's scale (MIDI note 69). */
const A4_CENTS = 6900;
const A4_HZ = 440;

/** Convert integer cents above MIDI note 0 into hertz. */
export function centsToHz(cents: number): number {
  return A4_HZ * math.pow(2, (cents - A4_CENTS) / 1200);
}

/** Convert hertz into cents above MIDI note 0. */
export function hzToCents(hz: number): number {
  if (hz <= 0) return 0;
  return A4_CENTS + (1200 * math.log(hz / A4_HZ)) / 0.6931471805599453;
}

/** What a channel can actually play, and what it cost to get there. */
export interface SnappedPitch {
  /** The divider to program; the chip binding turns it into register bits. */
  divider: number;
  /** The frequency the hardware will really produce. */
  hz: number;
  /** Signed cents between the request and the result. */
  centsError: number;
  /** Set when the request was outside the lattice and had to be clamped. */
  clamped?: "below" | "above";
}

/**
 * Snap a frequency onto a channel's lattice.
 *
 * Rounding is to the nearest *divider*, not the nearest frequency, because the
 * divider is what exists — and the two differ, since the lattice is
 * logarithmically uneven and coarsens as pitch rises.
 */
export function snapPitch(lattice: PitchLattice, hz: number): SnappedPitch {
  const min = latticeMinHz(lattice);
  const max = latticeMaxHz(lattice);
  let clamped: "below" | "above" | undefined;
  let target = hz;
  if (target < min) {
    target = min;
    clamped = "below";
  } else if (target > max) {
    target = max;
    clamped = "above";
  }
  const multiplier = lattice.kind === "multiplier";
  const ideal = multiplier
    ? (target * lattice.step) / lattice.clockHz
    : lattice.clockHz / (lattice.step * target);
  let divider = Math.round(ideal);
  if (divider < lattice.minDivider) divider = lattice.minDivider;
  if (divider > lattice.maxDivider) divider = lattice.maxDivider;
  const actual = multiplier
    ? (lattice.clockHz * divider) / lattice.step
    : lattice.clockHz / (lattice.step * divider);
  return {
    divider,
    hz: actual,
    centsError: hzToCents(actual) - hzToCents(hz),
    ...(clamped ? { clamped } : {}),
  };
}

/**
 * Octave-fold a pitch into a lattice's range.
 *
 * The first reduction doc 17 reaches for when a part will not fit: a bassline an
 * octave up is still the bassline, and on a chip whose tone channels stop at
 * 109 Hz it is the difference between a part and no part at all.
 */
export function foldIntoRange(lattice: PitchLattice, hz: number): { hz: number; octaves: number } {
  const min = latticeMinHz(lattice);
  const max = latticeMaxHz(lattice);
  let value = hz;
  let octaves = 0;
  // Bounded so a nonsensical request cannot spin; eight octaves is the whole
  // usable range of any chip in scope.
  for (let i = 0; i < 8 && value < min; i += 1) {
    value *= 2;
    octaves += 1;
  }
  for (let i = 0; i < 8 && value > max; i += 1) {
    value /= 2;
    octaves -= 1;
  }
  return { hz: value, octaves };
}

/** Map a 0–1 loudness onto a channel's volume lattice, returning its step. */
export function snapVolume(
  volume: { steps: number; law: "linear" | "db"; stepDb?: number },
  level: number,
): number {
  const clamped = level < 0 ? 0 : level > 1 ? 1 : level;
  if (volume.steps <= 1) return clamped > 0 ? 1 : 0;
  if (volume.law === "linear") return Math.round(clamped * (volume.steps - 1));
  if (clamped <= 0) return 0;
  // A dB lattice is uniform in loudness, not amplitude: stepping linearly here
  // would crowd every useful level into the top two steps.
  const stepDb = volume.stepDb ?? 2;
  const db = (20 * math.log(clamped)) / 2.302585092994046;
  const step = volume.steps - 1 - Math.round(-db / stepDb);
  return step < 0 ? 0 : step > volume.steps - 1 ? volume.steps - 1 : step;
}
