/**
 * Gesture families (doc 18 §Stage 2).
 *
 * The candidate portfolio, and the counterpart of the image path's strategy
 * portfolio: each family is a *parameterized register program* that exists
 * because it wins for some class of sound. A family is a function from a handful
 * of numbers to channel frames — nothing more — which is what makes fitting a
 * search over a small, bounded space rather than an open-ended synthesis
 * problem.
 *
 * The shape of a sound over time carries its identity far more than its spectrum
 * does, which is why these are gestures rather than spectra. Hardware with four
 * registers per channel produced sounds people still recognize forty years
 * later, and it did it exactly this way.
 */

import { math } from "@demake/core";

import type { ChannelFrame } from "../chipscript.js";
import { centsToHz, hzToCents } from "../pitch.js";
import type { SoundClass } from "./analyze.js";

/** The parameters every family shares, in the units the fitter searches. */
export interface GestureParams {
  /** Ticks the effect lasts. */
  ticks: number;
  /** Starting pitch, in cents above MIDI note 0. */
  startCents: number;
  /** Pitch travel over the effect, in cents (may be negative). */
  sweepCents: number;
  /** Decay shape: 0 holds, 1 falls to silence by the end, >1 falls sooner. */
  decay: number;
  /** Duty index for pulse channels. */
  duty: number;
  /** Noise colour index; 0 is the deepest. */
  noisePeriod: number;
  /** Whether a noise channel uses its tonal short-LFSR mode. */
  noiseTonal: boolean;
}

/** One named gesture. */
export interface Gesture {
  id: string;
  summary: string;
  /** Classes this gesture is eligible for; the class gate uses it. */
  classes: readonly SoundClass[];
  /** Whether it needs a noise channel rather than a pitched one. */
  noise: boolean;
  frames(params: GestureParams): ChannelFrame[];
}

/**
 * Amplitude at `position` (0–1) under a decay exponent.
 *
 * A power curve: 1 is a linear fade, higher is a sharper pluck, 0 holds flat.
 * One parameter covers everything between a chime and a click, which is what
 * keeps the search space small enough to explore honestly.
 */
function level(position: number, decay: number): number {
  if (decay <= 0) return 1;
  const remaining = 1 - position;
  if (remaining <= 0) return 0;
  return math.pow(remaining, decay);
}

function pitched(params: GestureParams, shape: (position: number) => number): ChannelFrame[] {
  const frames: ChannelFrame[] = [];
  for (let tick = 0; tick < params.ticks; tick += 1) {
    const position = params.ticks <= 1 ? 0 : tick / (params.ticks - 1);
    const cents = params.startCents + shape(position) * params.sweepCents;
    frames.push({
      on: true,
      hz: centsToHz(cents),
      level: level(position, params.decay),
      duty: params.duty,
      retrigger: tick === 0,
    });
  }
  return frames;
}

/** The families, in a fixed order so the tournament is reproducible. */
export const GESTURES: readonly Gesture[] = [
  {
    id: "blip",
    summary: "a short tone with a fast decay",
    classes: ["tonal", "percussive"],
    noise: false,
    frames: (params) => pitched(params, () => 0),
  },
  {
    id: "sweep-up",
    summary: "a rising pitch ramp — jumps, pickups, launches",
    classes: ["swept", "tonal"],
    noise: false,
    frames: (params) => pitched({ ...params, sweepCents: Math.abs(params.sweepCents) }, (p) => p),
  },
  {
    id: "sweep-down",
    summary: "a falling ramp — falls, deaths, lasers",
    classes: ["swept", "tonal", "percussive"],
    noise: false,
    frames: (params) => pitched({ ...params, sweepCents: -Math.abs(params.sweepCents) }, (p) => p),
  },
  {
    id: "sweep-updown",
    summary: "up then down — bounces",
    classes: ["swept", "tonal"],
    noise: false,
    frames: (params) => pitched(params, (p) => (p < 0.5 ? p * 2 : 2 - p * 2)),
  },
  {
    id: "arp-sparkle",
    summary: "a fast arpeggio through a chord — coins, pickups, level-ups",
    classes: ["tonal", "swept"],
    noise: false,
    frames: (params) => {
      // A major triad plus the octave, stepped every other tick: the coin sound
      // of an entire era, and the cheapest way to imply harmony on one channel.
      const steps = [0, 400, 700, 1200];
      const frames: ChannelFrame[] = [];
      for (let tick = 0; tick < params.ticks; tick += 1) {
        const position = params.ticks <= 1 ? 0 : tick / (params.ticks - 1);
        const step = steps[Math.floor(tick / 2) % steps.length]!;
        frames.push({
          on: true,
          hz: centsToHz(params.startCents + step + position * params.sweepCents),
          level: level(position, params.decay),
          duty: params.duty,
          retrigger: tick % 2 === 0,
        });
      }
      return frames;
    },
  },
  {
    id: "bell",
    summary: "a tone with a long decay and a slight downward drift",
    classes: ["tonal"],
    noise: false,
    frames: (params) => pitched({ ...params, decay: Math.max(params.decay, 1) }, (p) => p * 0.15),
  },
  {
    id: "noise-burst",
    summary: "noise with a fitted colour and decay — explosions, hits",
    classes: ["noisy", "percussive"],
    noise: true,
    frames: (params) => {
      const frames: ChannelFrame[] = [];
      for (let tick = 0; tick < params.ticks; tick += 1) {
        const position = params.ticks <= 1 ? 0 : tick / (params.ticks - 1);
        frames.push({
          on: true,
          hz: 0,
          level: level(position, params.decay),
          noisePeriod: params.noisePeriod,
          noiseTonal: params.noiseTonal,
          retrigger: tick === 0,
          // Percussion rings on the chip's own envelope; the fitter picks its
          // rate from the decay it measured rather than writing every tick.
          envelopePeriod: envelopeFor(params.decay),
        });
      }
      return frames;
    },
  },
  {
    id: "pitched-noise",
    summary: "noise sliding in colour — sword clashes, engine hits",
    classes: ["percussive", "noisy"],
    noise: true,
    frames: (params) => {
      const frames: ChannelFrame[] = [];
      for (let tick = 0; tick < params.ticks; tick += 1) {
        const position = params.ticks <= 1 ? 0 : tick / (params.ticks - 1);
        const slide = Math.round((params.sweepCents / 1200) * 8);
        frames.push({
          on: true,
          hz: 0,
          level: level(position, params.decay),
          noisePeriod: params.noisePeriod + Math.round(slide * position),
          noiseTonal: true,
          retrigger: tick === 0,
          envelopePeriod: envelopeFor(params.decay),
        });
      }
      return frames;
    },
  },
  {
    id: "click",
    summary: "a single-tick impulse — UI ticks",
    classes: ["percussive"],
    noise: true,
    frames: (params) => [
      {
        on: true,
        hz: 0,
        level: 1,
        noisePeriod: params.noisePeriod,
        noiseTonal: false,
        retrigger: true,
        envelopePeriod: 1,
      },
      ...Array.from({ length: Math.max(params.ticks - 1, 0) }, () => ({
        on: false,
        hz: 0,
        level: 0,
      })),
    ],
  },
];

/** Map a decay exponent onto a hardware envelope period, 0–7. */
function envelopeFor(decay: number): number {
  const period = Math.round(7 - decay * 2);
  return period < 1 ? 1 : period > 7 ? 7 : period;
}

/** The families eligible for a class, in portfolio order. */
export function gesturesFor(soundClass: SoundClass, hasNoiseChannel: boolean): Gesture[] {
  return GESTURES.filter(
    (gesture) => gesture.classes.includes(soundClass) && (!gesture.noise || hasNoiseChannel),
  );
}

/** A starting parameter set read straight off the analysis. */
export function seedParams(options: {
  ticks: number;
  startHz: number;
  endHz: number;
  decay: number;
  brightness: number;
}): GestureParams {
  const startCents = options.startHz > 0 ? hzToCents(options.startHz) : 6000;
  const endCents = options.endHz > 0 ? hzToCents(options.endHz) : startCents;
  return {
    ticks: options.ticks,
    startCents,
    sweepCents: endCents - startCents,
    decay: options.decay,
    duty: 2,
    // Brightness maps onto noise colour directly: the index runs low to high and
    // so does the centroid.
    noisePeriod: Math.round(Math.min(Math.max(options.brightness / 200, 0), 60)),
    noiseTonal: false,
  };
}
