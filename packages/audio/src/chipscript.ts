/**
 * `ChipScript` — the hardware side (doc 16 §Two representations).
 *
 * A timed register-write schedule and nothing else. That is the single most
 * important decision in the audio domain, because it makes four things the same
 * object: what our chip model synthesizes, what the generated driver must write
 * tick for tick, what an emulator's chip actually receives when the ROM runs,
 * and what the compliance oracle checks.
 *
 * There is no musical layer left in it to disagree about. By the time material
 * reaches a `ChipScript`, a note is a divider, a volume step and the tick they
 * were written on.
 */

import type { RegisterWrite } from "@demake/chip";

/** One driver tick: the writes the chip receives before time moves on. */
export interface TickWrites {
  /** Ordered as the driver will perform them. */
  writes: RegisterWrite[];
  /** Which chip they address, for consoles with more than one. */
  chip?: number;
}

/** An exact rate as a ratio; never a float, so it cannot drift. */
export interface Rational {
  num: number;
  den: number;
}

/** What a channel is doing on a given tick, before the binding encodes it. */
export interface ChannelFrame {
  /** Whether the channel should be sounding. */
  on: boolean;
  /** Requested frequency in Hz; the binding snaps it to the lattice. */
  hz: number;
  /** Requested loudness, 0–1. */
  level: number;
  /** Duty index into the channel's `duties`, where it has them. */
  duty?: number;
  /** Noise period index, for noise channels. */
  noisePeriod?: number;
  /** Whether a noise channel should use its tonal (short-LFSR) mode. */
  noiseTonal?: boolean;
  /**
   * Stereo placement: `-1` hard left, `0` centre, `+1` hard right.
   *
   * A *position* rather than a pair of switches, because six of the eleven
   * chips with a binding pan by level — the T6W28's two attenuators, the
   * S-DSP's signed per-side volumes, the DS SPU's seven-bit pan, the VSU's two
   * nibbles, the HuC6280's balance byte and the WonderSwan's volume byte — and
   * a boolean pair can only ask any of them for full or cut. The chips that
   * really do pan by switch (`NR51`, the Game Gear's stereo latch, an FM
   * voice's two output bits) quantise it through `panSides`; the rest spend it
   * through `panGains`. Absent is centre, and centre is both sides at full
   * under either law — so a part the arranger does not move encodes exactly the
   * bytes it did when this was a pair of booleans.
   */
  pan?: number;
  /**
   * Vibrato depth, 0–1, for a channel whose chip performs it in hardware.
   *
   * Present only where the binding said it would (`ChipBinding.lfoChannels`).
   * Everywhere else the modulation is already *in* `hz`, because a chip with no
   * LFO can only be given a moving pitch — so a binding that ignores this field
   * is correct on every console but the two FM ones, and those two say so.
   */
  vibrato?: number;
  /** Peak deviation the vibrato asks for, in cents, where `vibrato` is set. */
  vibratoCents?: number;
  /**
   * Peak attenuation the tremolo asks for, in decibels, on the same terms.
   *
   * Present only where the binding performs amplitude modulation in hardware,
   * which is the same set of channels `vibrato` is stated for and for the same
   * reason: they are two outputs of one LFO. Everywhere else the modulation is
   * already *in* `level`.
   */
  tremoloDb?: number;
  /**
   * A note starts on this tick.
   *
   * The arranger knows where notes begin and the binding does not, so it is
   * stated rather than inferred. It decides where a chip is re-triggered — and
   * on a percussion channel, re-triggering mid-decay would restart the noise
   * instead of letting it ring.
   */
  retrigger?: boolean;
  /**
   * Hardware envelope period, 0–7, where the chip has one (0 disables it).
   *
   * Used for percussion, whose decay the chip can shape for free. Melodic
   * channels shape their own level per tick instead, because a hardware decay
   * cannot be told to hold.
   */
  envelopePeriod?: number;
}

/** Which part a channel carried, and over which ticks. */
export interface ChannelSpan {
  channelId: string;
  partId: string;
  startTick: number;
  endTick: number;
  /** Why this pairing: `direct`, `arpeggiated`, `folded`, `merged`. */
  treatment: "direct" | "arpeggiated" | "folded" | "merged";
  /**
   * Where across the stereo image the channel was placed: `-1` … `+1`.
   *
   * Reported rather than left implicit because a placement is otherwise
   * invisible in everything but the audio itself — `--json` and the page's
   * piano roll both read this, and a console that quantises it through
   * `panSides` still says what the arranger asked for rather than what its
   * hardware could take.
   */
  pan: number;
}

/** Something the arrangement could not keep, counted rather than lost. */
export interface Dropped {
  kind: "part" | "note" | "voice";
  partId: string;
  /** How many notes this covers. */
  count: number;
  /** Mean salience of what went, so the cost is visible. */
  salience: number;
  reason: string;
}

/** How the driver's tick is produced, and how exactly it hit the tempo. */
export interface TimingReport {
  source: "vblank" | "timer" | "line-irq" | "spc-timer";
  /** The register value that produces this rate, where there is one. */
  divisor?: number;
  requestedBpm: number;
  achievedBpm: number;
  /** Signed tempo error in parts per million. */
  ppmError: number;
  rowsPerBeat: number;
  /** Worst distance from a row's ideal position, in milliseconds. */
  maxOnsetDeviationMs: number;
  /**
   * Whether timing error accumulates.
   *
   * The requirement is not that jitter is small but that a bar boundary lands
   * where it should after ninety seconds (doc 17 §Stage 5). This must be false.
   */
  accumulates: boolean;
}

/** A complete, hardware-executable piece of audio. */
export interface ChipScript {
  console: string;
  chips: readonly string[];
  driver: {
    rate: Rational;
    source: TimingReport["source"];
    divisor?: number;
  };
  ticks: TickWrites[];
  /** Tick playback returns to; `-1` for a one-shot (a sound effect). */
  loopTick: number;
  channels: ChannelSpan[];
  timing: TimingReport;
  /**
   * The sample RAM a schedule needs, where the chip plays samples rather than
   * generating them.
   *
   * The Super Nintendo's, and only its: "play sample 3" means nothing without
   * the samples, so a schedule for a sample player is only half an artifact. The
   * register stream is still the whole of the compliance contract — it is what
   * the driver must write — but a *render* needs this as well, which is a fact
   * about sample hardware rather than a leak in the representation.
   */
  sampleRam?: Uint8Array;
  budgets: {
    /** Total register writes, the rough proxy for driver data size. */
    writes: number;
    /** Most writes any single tick asks for. */
    peakWritesPerTick: number;
    /** The console's per-tick allowance, for comparison. */
    writeBudget: number;
  };
}

/** Total register writes in a script. */
export function countWrites(script: ChipScript): number {
  let total = 0;
  for (const tick of script.ticks) total += tick.writes.length;
  return total;
}

/** The most writes any one tick performs — the number the CPU budget bounds. */
export function peakWritesPerTick(script: ChipScript): number {
  let peak = 0;
  for (const tick of script.ticks) {
    if (tick.writes.length > peak) peak = tick.writes.length;
  }
  return peak;
}

/** Seconds of audio a script represents. */
export function scriptSeconds(script: ChipScript): number {
  return (script.ticks.length * script.driver.rate.den) / script.driver.rate.num;
}
