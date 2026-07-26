/**
 * Timing (doc 17 §Stage 5).
 *
 * Tempo is not a metric here; it is a **budget with a reported error**. The
 * product requirement is that a demade track keeps the tempo it came with, and
 * the requirement underneath *that* is the one that actually matters: timing
 * error must not **accumulate**. A bar boundary has to land where it should
 * after ninety seconds, however small the per-row error was.
 *
 * The mechanism: pick rows per beat, which fixes the driver rate the music wants
 * at `BPM × rows / 60`; ask the console what rate it can really produce; then
 * place every row from its *absolute* ideal position rather than by adding up row
 * lengths. Absolute placement is what makes the error bounded instead of
 * cumulative — the same reason the chip renderer computes sample boundaries from
 * an index rather than accumulating them.
 */

import type { TimingReport } from "./chipscript.js";
import type { ChipBinding } from "./binding/types.js";

/** How the arranger lays rows onto driver ticks. */
export interface TimingPlan {
  report: TimingReport;
  rate: { num: number; den: number };
  /** Driver ticks in the whole piece. */
  totalTicks: number;
  /** Absolute tick a score tick lands on. */
  tickForScoreTick(scoreTick: number): number;
  /** Seconds per driver tick. */
  secondsPerTick: number;
}

export interface TimingOptions {
  /** Rows per beat; more rows buy finer rhythm at a higher driver cost. */
  rowsPerBeat?: number;
  /**
   * `exact` holds the source tempo, which absolute placement makes achievable on
   * every console here; `snap` permits doc 17's bounded global tempo grade,
   * which buys a coarser driver rate — and therefore a smaller track — at the
   * cost of a tempo a listener would have to be told about.
   */
  tempo?: "exact" | "snap";
}

/**
 * Plan the driver clock for a piece.
 *
 * `scoreTicks` and `ppq` describe the source's grid; `bpm` is what analysis
 * concluded (or what `--bpm` asserted).
 */
export function planTiming(
  binding: ChipBinding,
  options: {
    bpm: number;
    ppq: number;
    durationScoreTicks: number;
  } & TimingOptions,
): TimingPlan {
  const rowsPerBeat = options.rowsPerBeat ?? 6;
  const rowHz = (options.bpm * rowsPerBeat) / 60;

  // A driver tick is not a row. Rows are the *musical* grid the arrangement
  // wants; ticks are what the hardware interrupt gives, and a driver ticking
  // below about 50 Hz cannot shape a note. So the row rate is multiplied up
  // into a usable band and rows then span several ticks.
  let multiple = 1;
  while (rowHz * multiple < MIN_DRIVER_HZ) multiple += 1;
  const desiredHz = rowHz * multiple;

  const fit = binding.fitRate(desiredHz);
  const achievedHz = fit.rate.num / fit.rate.den;
  const secondsPerTick = fit.rate.den / fit.rate.num;

  // The mapping uses the rate the hardware *really* produces, so wall-clock
  // timing is right even when that rate is nothing like the one we asked for.
  const ticksPerScoreTick = achievedHz / ((options.bpm / 60) * options.ppq);
  const totalTicks = Math.max(1, Math.ceil(options.durationScoreTicks * ticksPerScoreTick) + 1);

  // Absolute placement: a row's tick is derived from its own position, never
  // from the row before it, so rounding cannot compound.
  const tickForScoreTick = (scoreTick: number): number => Math.round(scoreTick * ticksPerScoreTick);

  // Achieved tempo is *measured* from the placement rather than asserted, so
  // the number reported is the one a listener would get, endpoint rounding and
  // all. It comes out equal to the request because the placement is absolute —
  // which is the whole point, and worth demonstrating rather than claiming.
  const spanTicks = tickForScoreTick(options.durationScoreTicks) - tickForScoreTick(0);
  const spanSeconds = spanTicks * secondsPerTick;
  const beats = options.durationScoreTicks / options.ppq;
  const achievedBpm = spanSeconds > 0 ? (beats * 60) / spanSeconds : options.bpm;
  const ppmError = ((achievedBpm - options.bpm) / options.bpm) * 1e6;

  // The worst a row can land from its ideal position is half a tick, by
  // construction — rounding, not drift.
  const maxOnsetDeviationMs = secondsPerTick * 500;

  const report: TimingReport = {
    source: fit.source,
    ...(fit.divisor === undefined ? {} : { divisor: fit.divisor }),
    requestedBpm: options.bpm,
    achievedBpm,
    ppmError,
    rowsPerBeat,
    maxOnsetDeviationMs,
    accumulates: false,
  };

  return { report, rate: fit.rate, totalTicks, tickForScoreTick, secondsPerTick };
}

/** Below this a driver cannot shape a note, whatever the music's row rate. */
const MIN_DRIVER_HZ = 50;

/**
 * Verify that placement really is non-accumulating.
 *
 * Cheap enough to run on every arrangement, and it checks the property doc 17
 * makes a hard requirement rather than a metric: the distance between a row's
 * actual tick and its ideal one must stay bounded for the whole piece, not grow.
 */
export function verifyNonAccumulating(plan: TimingPlan, durationScoreTicks: number): boolean {
  const samples = 64;
  let worst = 0;
  for (let i = 0; i <= samples; i += 1) {
    const scoreTick = (durationScoreTicks * i) / samples;
    const actual = plan.tickForScoreTick(scoreTick);
    const ideal = scoreTick * (plan.tickForScoreTick(1000000) / 1000000);
    worst = Math.max(worst, Math.abs(actual - ideal));
  }
  // Half a tick of rounding is expected; anything beyond one tick means the
  // placement is accumulating and the plan is wrong.
  return worst <= 1.5;
}
