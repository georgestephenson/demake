/**
 * The `AudioSpec` schema (doc 16 §The `AudioSpec` schema).
 *
 * A console's sound hardware, declared as data, on exactly the terms doc 03
 * declares its video hardware: the constraint model is data and the optimizer is
 * generic. The arranger in `@demake/audio` reads only this — it has no per-console
 * branches — which is what makes adding a console a spec file rather than a
 * special case.
 *
 * **This module is data and types only.** No synthesis, no register encoding, no
 * dependency on `@demake/chip`: `core` stands alone and the dependency runs one
 * way (doc 02 §Dependency rules). The named chips are resolved to models and to
 * register encoders by `@demake/audio`, which is also where a name that does not
 * resolve becomes an error.
 */

/** What a channel fundamentally is, which decides what it can carry. */
export type ChannelKind = "pulse" | "wave" | "noise" | "triangle" | "fm" | "sample";

/**
 * The set of frequencies a channel can actually produce.
 *
 * Every pitched channel in the era works the same way: a counter divides a clock,
 * so `f = clockHz / (step × divider)` and the reachable pitches are a lattice
 * that coarsens as it rises. Two facts fall straight out and are used all over
 * doc 17 — the cents error of any requested note, and the channel's hard floor
 * and ceiling. The *encoding* of a divider into register bits differs per chip
 * and lives with the chip binding; what a musician can hear lives here.
 */
export interface PitchLattice {
  clockHz: number;
  /** Clocks per divider count, e.g. 32 for a Game Boy pulse. */
  step: number;
  /** Smallest usable divider (highest note). */
  minDivider: number;
  /** Largest usable divider (lowest note). */
  maxDivider: number;
}

/** Lowest frequency a lattice can produce, in Hz. */
export function latticeMinHz(lattice: PitchLattice): number {
  return lattice.clockHz / (lattice.step * lattice.maxDivider);
}

/** Highest frequency a lattice can produce, in Hz. */
export function latticeMaxHz(lattice: PitchLattice): number {
  return lattice.clockHz / (lattice.step * lattice.minDivider);
}

/** How loud a channel can be told to be. */
export interface VolumeLattice {
  /** Number of distinct levels; `1` means the channel has no volume control. */
  steps: number;
  /** `linear` — amplitude steps (Game Boy, NES); `db` — attenuation steps (PSG). */
  law: "linear" | "db";
  /** Decibels per step for `db` laws. */
  stepDb?: number;
}

/** A volume envelope the *chip* runs without the driver writing every tick. */
export interface HardwareEnvelope {
  /** `decay` — the Game Boy / NES step envelope; `none` — the driver does it all. */
  kind: "decay" | "none";
  /** Envelope steps per second at the fastest setting. */
  ratePerSecond?: number;
}

/** One hardware voice. */
export interface AudioChannelSpec {
  /** Stable identifier used in channel plans and `--reserve`, e.g. `pulse1`. */
  id: string;
  kind: ChannelKind;
  /** Which entry of {@link AudioSpec.chips} this voice belongs to. */
  chip: number;
  pitch?: PitchLattice;
  volume: VolumeLattice;
  /** Selectable duty cycles, as fractions; absent when the shape is fixed. */
  duties?: readonly number[];
  envelope?: HardwareEnvelope;
  /** Wavetable shape, for channels that play RAM (Game Boy CH3, PCE, WS). */
  waveform?: { samples: number; bits: number };
  /** Noise generator: how many periods it offers and whether it has a tonal mode. */
  noise?: { periods: number; tonalMode: boolean };
  /** Stereo placement this channel supports. */
  panning?: "none" | "lr-enable" | "lr-level";
}

/** Where the driver's tick comes from, which decides what tempos are exact. */
export type DriverClock = "vblank" | "timer" | "line-irq" | "spc-timer";

/** An exact rate as a ratio, avoiding a float in a spec. */
export interface RateSpec {
  num: number;
  den: number;
}

/** A console's sound hardware. */
export interface AudioSpec {
  /**
   * Chip names, resolved to models by `@demake/audio`.
   *
   * A plain string rather than a typed id because `core` may not depend on
   * `@demake/chip`; the audio package fails loudly on a name it cannot resolve,
   * and a test pins that every spec here resolves.
   */
  chips: readonly string[];
  channels: readonly AudioChannelSpec[];
  driver: {
    /** Clock sources in preference order; the first is the default. */
    sources: readonly DriverClock[];
    /** The console's frame rate, used by the `vblank` source. */
    frameRate: RateSpec;
    /** Driver tick rates the timer source can produce, as a range in Hz. */
    timerRange?: readonly [min: number, max: number];
    /** Register writes one tick may perform inside its CPU budget. */
    writesPerTick: number;
  };
  budgets: {
    /** Bytes of ROM a track may occupy before the budget stage intervenes. */
    romBytes: number;
    /** Sample RAM, where the console has any (SNES ARAM, NDS). */
    sampleRamBytes?: number;
  };
  mixing: {
    channels: 1 | 2;
    /** Whether channel outputs sum linearly (the NES's do not). */
    linear: boolean;
  };
  docs: { sources: readonly string[] };
}
