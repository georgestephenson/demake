/**
 * The Mega Drive binding: ten voices across two chips.
 *
 * The first console in this set whose sound hardware is *two* devices, and the
 * reason `BoundWrite.chip` exists. Six four-operator FM voices on a YM2612 and
 * four tone generators on an SN76489, arranged against as one instrument —
 * because that is what they are on the board, and because an arranger that had
 * to be told which chip a part belongs on would be making a decision that the
 * cost function already makes better.
 *
 * Three things here are this console's rather than either chip's:
 *
 *   - **The PSG half is the Master System's, unchanged.** The same encoder, the
 *     same latch discipline, the same attenuation table — {@link psgBinding} is
 *     called rather than reimplemented, and its writes are simply tagged as
 *     chip 1. What the two consoles do *not* share is the driver, and that is a
 *     fact about the 68000 rather than about the chip.
 *   - **A patch is fitted, and it is fitted once per part.** Timbre on an FM
 *     voice is a search (`fm-patch.ts`), and the search is expensive next to
 *     everything else the arranger does — so the binding is *told* the patches
 *     by the arranger rather than fitting one per tick, and a channel that
 *     changes hands mid-track reinstalls the new part's.
 *   - **The two chips are balanced here, not in either model.** An SN76489 that
 *     normalised itself for a Master System would be far too loud against six FM
 *     voices, and the model must not know which board it is on — so the level a
 *     `ChannelFrame` asks for is mapped through a per-chip calibration and the
 *     PSG's ceiling is the quieter one, which is what the hardware does.
 *
 * Sources:
 * - Sega — YM2612 application manual (register map, key-on, F-number)
 * - Plutiedev — YM2612 from the 68000: https://plutiedev.com/ym2612-registers
 */

import type { AudioSpec } from "@demake/core";

import type { ChannelFrame } from "../chipscript.js";

import {
  carriersOf,
  fnumAt,
  type FmBindingOptions,
  amsFor,
  amWrites,
  fmsFor,
  lfoRateIndex,
  lfoRegister,
  lfoWanted,
  patchWrites,
  pitchWrites,
  totalLevelFor,
  type FmPatch,
} from "./fm-patch.js";
// Kept exported from here as well: both are this console's encoding as much as
// the other's, and a caller that had one from `md.ts` should still find it.
export { totalLevelFor };

import { panSides } from "./pan.js";
import { VIBRATO_HZ } from "../vibrato.js";
import { psgBinding } from "./psg.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

/** FM voices, which are the first six entries of the console's channel list. */
export const FM_CHANNELS = 6;

/** The YM2612's clock, and the divider that makes its internal sample rate. */
const YM_CLOCK = 7670453;
const YM_SAMPLE_DIVIDER = 144;

/**
 * How loud the PSG is allowed to be against the FM.
 *
 * The chip models each normalise to their own full scale, which is right for a
 * Master System and wrong for a board where four tone generators sit beside six
 * FM voices. So something has to state the *board's* weighting, and putting it
 * here rather than in `Sn76489` is what keeps that model one model.
 *
 * **Six decibels is not what the board does, and the schematic says so.** On a
 * Model 1 the two chips meet at a passive summing node in front of the
 * headphone amplifier, and they reach it through very different resistors: the
 * VDP's PSG pin drives a 2.2 kΩ load and a 220 pF cap, is coupled by 1 µF, and
 * is summed through **51 kΩ** — one for each channel, since that output is
 * mono — while each of the YM2612's MOL/MOR drives its own 2.2 kΩ load, is
 * coupled by 10 µF, and is summed through **2.2 kΩ**. That is a ratio of 23.2
 * to 1, or **27.3 dB**, where this constant applies 6.
 *
 * What the schematic settles is the board's half exactly; what it does not
 * settle on its own is the two parts' full-scale output levels, which is the
 * other term and which no model here measures. So this is left where it was
 * rather than moved to 27 dB on a half-derivation — moving it re-bases every
 * Mega Drive render and is the maintainer's call (doc 13 §A5.5). Three
 * independent lines now point the same way, though, and this constant is the
 * outlier on all three: the schematic's network, genesis-plus-gx's own
 * `psg_preamp` default, and the Level B spectrum that measures the two against
 * each other.
 *
 * Source: Sega Genesis (Model 1) sound and video schematic — R31/C39/C40 and
 * R34/R37 on the PSG side, R53/R54 and the 2.2 kΩ pair on the FM side.
 */
export const MD_CHIP_GAINS: readonly number[] = [1, 0.5];

/** What the arranger hands the binding beyond the frames: one patch per voice. */
export type MdBindingOptions = FmBindingOptions;

/**
 * Build the Mega Drive's binding.
 *
 * `patches` is how a fitted timbre reaches the register encoder. Rebuilding the
 * binding with different patches is how a track changes instrument — the writes
 * that install one are emitted on the first tick a channel sounds, so a fresh
 * binding restates them rather than assuming the chip still holds the last one.
 */
export function mdBinding(
  console: string,
  spec: AudioSpec,
  options: MdBindingOptions = {},
): ChipBinding {
  const psg = psgBinding(console, psgSpec(spec));
  const patches = options.patches ?? [];
  /** Which patch each FM channel currently holds, so it is installed once. */
  const installed: (FmPatch | undefined)[] = new Array(FM_CHANNELS).fill(undefined) as undefined[];
  /**
   * Whether each channel's carriers currently have their AM enable set.
   *
   * Beside `installed` rather than inside it, because a tremolo belongs to a
   * *note* and the same patch plays notes with and without one — so this is the
   * one part of a channel's register state a patch does not decide.
   */
  const modulated: boolean[] = new Array(FM_CHANNELS).fill(false) as boolean[];

  return {
    console,
    chips: spec.chips,
    spec,
    chipGains: MD_CHIP_GAINS,
    // The six FM voices bend themselves; the PSG half has no LFO and is left to
    // `compile.ts`'s per-tick pitch writes (doc 17 §Vibrato).
    lfoChannels: new Set(Array.from({ length: FM_CHANNELS }, (_, index) => index)),

    init(): BoundWrite[] {
      const out: BoundWrite[] = [];
      // The FM chip first, because silencing it is what stops a soft reset
      // leaving a note ringing under the first bar.
      out.push(...ym(0x22, 0x00)); // LFO off
      out.push(...ym(0x27, 0x00)); // no timers, channel 3 in normal mode
      out.push(...ym(0x2b, 0x00)); // DAC off; channel 6 is a voice, not a sampler
      for (let channel = 0; channel < FM_CHANNELS; channel += 1) {
        out.push(...ymKey(channel, 0));
        // Both speakers, no LFO sensitivity. A channel with neither enabled is
        // silent whatever its operators are doing, which is a mute that survives
        // every other write and is therefore worth stating at boot.
        out.push(...ymChannel(channel, 0xb4, 0xc0));
        for (let position = 0; position < 4; position += 1) {
          out.push(...ymChannel(channel, 0x40 + position * 4, 0x7f));
        }
      }
      out.push(...psg.init().map(asPsg));
      installed.fill(undefined);
      // The boot's `$60` writes have not happened yet — a patch has not been
      // installed — so no carrier has its AM bit set and the shadow says so.
      modulated.fill(false);
      return out;
    },

    encode(next, prev): BoundWrite[] {
      const out: BoundWrite[] = [];
      // `$22` is the whole chip's, so it is switched on the first tick anything
      // asks for vibrato and never touched again. Lazily rather than at boot,
      // because `init()` writing it unconditionally would change the register
      // stream of every track that has no vibrato in it — which is all of them
      // in the example library — for no audible difference at all.
      const wants = lfoWanted(next);
      if (wants !== lfoWanted(prev)) {
        out.push(...ym(0x22, wants ? lfoRegister(lfoRateIndex(VIBRATO_HZ)) : 0x00));
      }
      for (let channel = 0; channel < FM_CHANNELS; channel += 1) {
        encodeFm(
          out,
          channel,
          next[channel]!,
          prev?.[channel],
          patches[channel],
          installed,
          modulated,
        );
      }
      out.push(
        ...psg
          .encode(next.slice(FM_CHANNELS), prev === undefined ? undefined : prev.slice(FM_CHANNELS))
          .map(asPsg),
      );
      return out;
    },

    fitRate(desiredHz): DriverRateFit {
      // The YM2612's timer A is a real programmable clock, which is what this
      // console has and the Sega 8-bits do not: ten bits counting the chip's own
      // sample rate. The frame is still the candidate to beat, because a game's
      // driver rides the picture's interrupt whatever a standalone track could.
      const frameHz = spec.driver.frameRate.num / spec.driver.frameRate.den;
      let best: DriverRateFit = { rate: spec.driver.frameRate, source: "vblank" };
      let bestError = Math.abs(frameHz - desiredHz);
      const sampleRate = YM_CLOCK / YM_SAMPLE_DIVIDER;
      for (let reload = 0; reload < 1024; reload += 1) {
        const hz = sampleRate / (1024 - reload);
        if (hz < 30 || hz > 800) continue;
        const error = Math.abs(hz - desiredHz);
        if (error < bestError - 1e-12) {
          bestError = error;
          best = {
            rate: { num: YM_CLOCK, den: YM_SAMPLE_DIVIDER * (1024 - reload) },
            source: "timer",
            divisor: reload,
          };
        }
      }
      return best;
    },
  };
}

/** The PSG's own spec, as `psgBinding` expects to be handed one. */
function psgSpec(spec: AudioSpec): AudioSpec {
  return {
    ...spec,
    chips: ["sn76489"],
    channels: spec.channels.slice(FM_CHANNELS).map((channel) => ({ ...channel, chip: 0 })),
    // The Mega Drive's PSG has no stereo latch — that device is the Game Gear's,
    // and this console's panning lives in the FM chip's own per-channel bits.
    mixing: { channels: 1, linear: true },
  };
}

/** Tag a write from the PSG binding as this console's second chip. */
function asPsg(write: BoundWrite): BoundWrite {
  return { reg: write.reg, value: write.value, chip: 1 };
}

/** One YM2612 register write, as the two bus writes it really is. */
function ym(address: number, value: number, half = 0): BoundWrite[] {
  return [
    { reg: half * 2, value: address, chip: 0 },
    { reg: half * 2 + 1, value, chip: 0 },
  ];
}

/** A per-channel register, which is an address plus the channel within its half. */
function ymChannel(channel: number, address: number, value: number): BoundWrite[] {
  return ym(address + (channel % 3), value, channel < 3 ? 0 : 1);
}

/**
 * Key on or off.
 *
 * The key register lives on the first half of the bus for *every* channel — it
 * is the one per-channel register that does — and the channel is encoded in its
 * low three bits with a gap at 3. Getting that wrong keys the wrong voice, which
 * sounds like a stuck note rather than like a mistake.
 */
function ymKey(channel: number, slots: number): BoundWrite[] {
  const encoded = channel < 3 ? channel : channel + 1;
  return ym(0x28, (slots << 4) | encoded);
}

/**
 * One FM voice's writes for this tick.
 *
 * The order matters and it is the hardware's: install the patch if it changed,
 * set the carriers' level, set the pitch, then key. A key-on before the pitch
 * would sound the previous note for one tick, which at 60 Hz is audible as a
 * click on every note of a fast line.
 */
function encodeFm(
  out: BoundWrite[],
  channel: number,
  frame: ChannelFrame,
  before: ChannelFrame | undefined,
  patch: FmPatch | undefined,
  installed: (FmPatch | undefined)[],
  modulated: boolean[],
): void {
  const wanted = patch ?? DEFAULT_PATCH;
  // A tremolo is per *note*, so whether the carriers have their AM bit set is
  // part of what a channel's registers currently say — and it is tracked beside
  // the patch rather than folded into it, because the same patch plays notes
  // with and without one.
  const wantAm = (frame.on ? (frame.tremoloDb ?? 0) : 0) > 0;
  if (installed[channel] !== wanted) {
    out.push(...patchWrites(wanted, channel, wantAm).map((write) => ({ ...write, chip: 0 })));
    installed[channel] = wanted;
    modulated[channel] = wantAm;
    // A fresh patch means the previous tick says nothing about the chip's state,
    // so everything below is stated rather than diffed.
    before = undefined;
  }

  if (!frame.on) {
    if (before === undefined || before.on) out.push(...ymKey(channel, 0));
    return;
  }

  if (modulated[channel] !== wantAm) {
    out.push(...amWrites(wanted, channel, wantAm).map((write) => ({ ...write, chip: 0 })));
    modulated[channel] = wantAm;
  }

  const pitch = fnumFor(frame.hz);
  const changed = before === undefined || !before.on || fnumChanged(before.hz, frame.hz);
  const retrigger = frame.retrigger === true || before === undefined || !before.on;

  // Total level is attenuation in 0.75 dB steps and only the *carriers* carry the
  // note's volume: writing it to a modulator would change the timbre instead,
  // which is the single most common way to get FM dynamics wrong.
  const level = totalLevelFor(frame.level);
  const beforeLevel = before?.on === true ? totalLevelFor(before.level) : -1;
  if (level !== beforeLevel) {
    for (const slot of carriersOf(wanted.algorithm)) {
      out.push(...ymChannel(channel, 0x40 + REGISTER_POSITION[slot]! * 4, level));
    }
  }

  // An FM voice has one output bit a side and nothing between them, so a
  // position is quantised rather than spent — this is the one part of this
  // console's stereo the PSG half does not share (its own is `psg.ts`'s).
  //
  // The same byte carries *both* LFO sensitivities, so the three are one write:
  // the panning in bits 7-6, the tremolo depth in bits 5-4 and the vibrato
  // depth in bits 2-0. Writing either
  // without the other is what would silently cancel a placement or a vibrato,
  // which is why neither is emitted on its own.
  const sides = panSides(frame.pan);
  const panBits =
    (sides.left ? 0x80 : 0) |
    (sides.right ? 0x40 : 0) |
    (amsFor(frame.tremoloDb ?? 0) << 4) |
    fmsFor(frame.vibratoCents ?? 0);
  const wasSides = panSides(before?.pan);
  const beforePan =
    before?.on === true
      ? (wasSides.left ? 0x80 : 0) |
        (wasSides.right ? 0x40 : 0) |
        (amsFor(before.tremoloDb ?? 0) << 4) |
        fmsFor(before.vibratoCents ?? 0)
      : -1;
  if (panBits !== beforePan) out.push(...ymChannel(channel, 0xb4, panBits));

  if (changed) out.push(...pitchWrites(channel, pitch.fnum, pitch.block).map(withChip));
  if (retrigger) {
    // A retrigger is key off then on: the hardware restarts an attack from
    // wherever the envelope had reached, and a repeated note that skipped the
    // off would not re-attack at all.
    out.push(...ymKey(channel, 0));
    out.push(...ymKey(channel, 0x0f));
  }
}

function withChip(write: { reg: number; value: number }): BoundWrite {
  return { reg: write.reg, value: write.value, chip: 0 };
}

/** Signal slot to the position it occupies in the register map. */
const REGISTER_POSITION: readonly number[] = [0, 2, 1, 3];

/**
 * A frequency as an F-number and a block, at this console's clock.
 *
 * The arithmetic is `fm-patch.ts`'s and the only thing this console supplies is
 * the sample rate, because the core is the same one a Neo Geo runs at 8 MHz.
 */
export function fnumFor(hz: number): { fnum: number; block: number } {
  return fnumAt(hz, YM_CLOCK / YM_SAMPLE_DIVIDER);
}

function fnumChanged(before: number, after: number): boolean {
  const a = fnumFor(before);
  const b = fnumFor(after);
  return a.fnum !== b.fnum || a.block !== b.block;
}

/**
 * What a channel plays when the arranger supplied no patch.
 *
 * A plain two-operator stack: audible, in tune, and obviously not a fitted
 * timbre — which is what a default should be. Every path that matters supplies
 * one from `fitPatchForPart`.
 */
const DEFAULT_PATCH: FmPatch = {
  algorithm: 4,
  feedback: 3,
  operators: [
    {
      detune: 3,
      multiple: 1,
      totalLevel: 26,
      keyScale: 1,
      attack: 31,
      decay: 10,
      sustainRate: 0,
      sustainLevel: 3,
      release: 7,
    },
    {
      detune: 0,
      multiple: 1,
      totalLevel: 0,
      keyScale: 1,
      attack: 31,
      decay: 10,
      sustainRate: 0,
      sustainLevel: 3,
      release: 7,
    },
    {
      detune: 3,
      multiple: 2,
      totalLevel: 30,
      keyScale: 1,
      attack: 31,
      decay: 12,
      sustainRate: 0,
      sustainLevel: 4,
      release: 7,
    },
    {
      detune: 0,
      multiple: 1,
      totalLevel: 0,
      keyScale: 1,
      attack: 31,
      decay: 12,
      sustainRate: 0,
      sustainLevel: 4,
      release: 7,
    },
  ],
};
