/**
 * The chip-model contract (doc 16 §Claim 2).
 *
 * A sound chip is a state machine driven by register writes. Everything in this
 * package implements exactly that: values go in through {@link ChipModel.write},
 * time advances through {@link ChipModel.run}, and audio comes out. There is no
 * notion of a note, an instrument or a song anywhere below this line — those
 * live in `@demake/audio`, and keeping them out is what lets one model serve the
 * emulator (`@demake/dmg`), the pipeline's preview, and the compliance oracle
 * without any of them disagreeing.
 *
 * **Output is band-limited by exact box integration.** Rather than point-sampling
 * a megahertz-rate signal (which aliases) or oversampling and filtering (which is
 * slow and adds a filter to argue about), a model advances only as far as its
 * next *event* — an edge, a timer reload, an envelope step — and reports the
 * level it held over that span. The sink accumulates `level × clocks` and divides
 * when an output sample closes, which is the exact average of what the chip
 * emitted during the sample window. Work is proportional to edges rather than
 * clocks, and no filter state crosses a sample boundary, so a render is
 * reproducible sample for sample on any engine (doc 02 §Floating-point
 * discipline).
 */

/** Chips demake can model. Extend by adding a model and a spec, never a branch. */
export type ChipId =
  "gb-apu" | "sn76489" | "nes-apu" | "ym2612" | "s-dsp" | "gba-pcm" | "nds-spu" | "huc6280-psg";

/** A single write to a chip register, in the chip's own address space. */
export interface RegisterWrite {
  reg: number;
  value: number;
  /**
   * Which chip of a multi-chip console this addresses; absent means the first.
   *
   * A Mega Drive is the case: six FM voices and four tone generators on two
   * devices, written within one driver tick, so the tag belongs to the write
   * rather than to the tick it lands on.
   */
  chip?: number;
}

/** De-interleaved audio: one `Float32Array` per output channel. */
export interface Pcm {
  sampleRate: number;
  /** 1 or 2 buffers of equal length, nominally in [-1, 1]. */
  channels: Float32Array[];
}

/**
 * Where a chip's integrated output goes.
 *
 * The chip reports a constant level held for a span of clocks; the sink
 * accumulates the area and closes an output sample when enough clocks have
 * passed. Sample boundaries are computed from an exact integer ratio, so they
 * never drift over the length of a track however awkward the clock rate is.
 */
export interface SampleSink {
  /**
   * Clocks remaining before the current output sample closes — always ≥ 1.
   *
   * A model uses this to bound its next step, which is what keeps every sample's
   * window exactly the clocks that belong to it.
   */
  clocksUntilSampleBoundary(): number;
  /**
   * Report `left`/`right` held constant for `clocks` clocks, advancing time.
   *
   * Closing a sample is the sink's business and happens automatically when the
   * boundary is reached, so a model never has to know the output rate.
   */
  add(left: number, right: number, clocks: number): void;
}

/**
 * A register-driven sound chip.
 *
 * Implementations are integer internally wherever the hardware is, and run in
 * their own clock domain — resampling to a delivery rate is the mixer's job
 * (`mix.ts`), never the chip's, so a chip model has exactly one behaviour to be
 * right about.
 */
export interface ChipModel {
  readonly id: ChipId;
  /** The model's master clock, in Hz. */
  readonly clockHz: number;
  /** Output channel count: 1 mono, 2 stereo. */
  readonly outputChannels: 1 | 2;
  /** Reset to power-on state. */
  reset(): void;
  /** Apply one register write at the current instant. */
  write(reg: number, value: number): void;
  /** Read a register back where the hardware allows it (wave RAM, status). */
  read?(reg: number): number;
  /** Advance by `clocks` chip clocks, delivering output to the sink. */
  run(clocks: number, sink: SampleSink): void;
}
