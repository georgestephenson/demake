/**
 * Chip bindings: where musical intent becomes register writes.
 *
 * A binding is the *only* place that knows a chip's register map, and it is
 * per-console rather than per-channel because the interesting registers are
 * shared — the NES's `$4015` enable mask, the Game Boy's `NR51` panning byte and
 * its `NR52` power bit. A per-channel encoder would have to invent a protocol
 * for who owns those, and would get it wrong.
 *
 * A binding also encodes *differences*. It receives the previous tick's channel
 * frames and the next one's, and emits only what changed — which is what a real
 * driver does, and the reason the per-tick write count stays inside a console's
 * CPU budget rather than blowing it on rewriting a steady note sixty times a
 * second.
 */

import type { AudioSpec } from "@demake/core";

import type { ChannelFrame, Rational, TimingReport } from "../chipscript.js";

/** A register write, tagged with its chip for multi-chip consoles. */
export interface BoundWrite {
  reg: number;
  value: number;
  chip?: number;
}

/** What a console's driver clock can actually produce. */
export interface DriverRateFit {
  rate: Rational;
  source: TimingReport["source"];
  divisor?: number;
}

/** The per-console register encoder. */
export interface ChipBinding {
  /** Console id this binding serves. */
  console: string;
  /** Chip model ids, in the order `BoundWrite.chip` indexes them. */
  chips: readonly string[];
  /** The spec the binding was built against. */
  spec: AudioSpec;
  /** Writes that put the chip in a known state before anything plays. */
  init(): BoundWrite[];
  /**
   * Writes that move the chip from `prev` to `next`.
   *
   * Both arrays are indexed by `spec.channels`. `prev` is `undefined` on the
   * first tick, which is how a binding knows to state everything rather than
   * diff against a guess.
   */
  encode(next: readonly ChannelFrame[], prev: readonly ChannelFrame[] | undefined): BoundWrite[];
  /**
   * The closest driver tick rate this console can actually produce.
   *
   * Consoles differ enormously here and it decides whether a tempo is exact or
   * merely close, so it belongs with the hardware rather than in a shared
   * approximation (doc 17 §Stage 5).
   */
  fitRate(desiredHz: number): DriverRateFit;
}

/** A silent frame — what a channel looks like when nothing is playing. */
export function silentFrame(): ChannelFrame {
  return { on: false, hz: 0, level: 0 };
}

/** `spec.channels.length` silent frames. */
export function silentFrames(spec: AudioSpec): ChannelFrame[] {
  return spec.channels.map(() => silentFrame());
}
