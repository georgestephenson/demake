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
  /**
   * How loud each chip is against the others, for a console with more than one.
   *
   * Absent where there is only one chip, which is every console but the Mega
   * Drive. It lives here rather than in a chip model because it is a fact about
   * the *board*: the same SN76489 is the whole output on a Master System and
   * sits well below six FM voices on a Mega Drive, and a model that knew which
   * would no longer be one model (doc 16 §Packages).
   */
  chipGains?: readonly number[];
  /**
   * Channel indices whose hardware performs vibrato without per-tick writes.
   *
   * The seam between the arranger's modulation and a chip LFO. `compile.ts`
   * bends the pitch and swells the level itself for every channel *not* named
   * here, because a chip with no LFO can only be given a moving pitch and a
   * moving volume; for the ones that are, it leaves `hz` and `level` as written
   * and states the depths in `ChannelFrame.vibrato` and `tremoloDb` for the
   * binding to program. The difference is what a track costs: a modulated held
   * note is a write per tick one way and a single sensitivity nibble the other.
   *
   * **One set for both**, because on the chip that has one there is one
   * oscillator: the pitch sweep and the amplitude sweep are two outputs of it,
   * so a binding cannot honour one and not the other.
   *
   * Absent on every binding but the two OPN ones. It is a property of the
   * *binding* rather than of `AudioSpec` because what it answers is "will this
   * encoder do it in hardware", which is a decision about the register map —
   * and the register map is exactly what a binding is the only place to know.
   */
  lfoChannels?: ReadonlySet<number>;
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
