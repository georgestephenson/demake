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

import { math, type AudioSpec } from "@demake/core";

import type { ChannelFrame } from "../chipscript.js";

import { carriersOf, patchWrites, pitchWrites, type FmPatch } from "./fm-patch.js";
import { psgBinding } from "./psg.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

/** The natural log of ten, for the one decibel conversion in this file. */
const LN10 = 2.302585092994046;

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
 * FM voices. Six decibels down is the balance the hardware has, and putting it
 * here rather than in `Sn76489` is what keeps that model one model.
 */
export const MD_CHIP_GAINS: readonly number[] = [1, 0.5];

/** What the arranger hands the binding beyond the frames: one patch per voice. */
export interface MdBindingOptions {
  /** Patch per FM channel, by channel index 0-5; a missing one gets a default. */
  patches?: readonly (FmPatch | undefined)[];
}

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

  return {
    console,
    chips: spec.chips,
    spec,
    chipGains: MD_CHIP_GAINS,

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
      return out;
    },

    encode(next, prev): BoundWrite[] {
      const out: BoundWrite[] = [];
      for (let channel = 0; channel < FM_CHANNELS; channel += 1) {
        encodeFm(out, channel, next[channel]!, prev?.[channel], patches[channel], installed);
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
): void {
  const wanted = patch ?? DEFAULT_PATCH;
  if (installed[channel] !== wanted) {
    out.push(...patchWrites(wanted, channel).map((write) => ({ ...write, chip: 0 })));
    installed[channel] = wanted;
    // A fresh patch means the previous tick says nothing about the chip's state,
    // so everything below is stated rather than diffed.
    before = undefined;
  }

  if (!frame.on) {
    if (before === undefined || before.on) out.push(...ymKey(channel, 0));
    return;
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

  const pan = frame.pan;
  const panBits = ((pan?.left ?? true) ? 0x80 : 0) | ((pan?.right ?? true) ? 0x40 : 0);
  const beforePan =
    before?.on === true
      ? ((before.pan?.left ?? true) ? 0x80 : 0) | ((before.pan?.right ?? true) ? 0x40 : 0)
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
 * A frequency as an F-number and a block.
 *
 * The block is chosen so the F-number lands in the top half of its range, which
 * is where the lattice is finest: the same note an octave lower in F-number
 * terms is the same pitch with half the resolution, and on a chip whose steps
 * are already sub-cent at the top that is the difference between exact and
 * merely close.
 */
export function fnumFor(hz: number): { fnum: number; block: number } {
  if (!(hz > 0)) return { fnum: 0, block: 0 };
  const sampleRate = YM_CLOCK / YM_SAMPLE_DIVIDER;
  // f = fnum * sampleRate * 2^(block-1) / 2^20
  let block = 0;
  let fnum = (hz * (1 << 20)) / sampleRate / 0.5;
  while (fnum >= 2048 && block < 7) {
    fnum /= 2;
    block += 1;
  }
  while (fnum < 1024 && block > 0) {
    fnum *= 2;
    block -= 1;
  }
  const rounded = Math.round(fnum);
  return { fnum: Math.max(0, Math.min(2047, rounded)), block };
}

function fnumChanged(before: number, after: number): boolean {
  const a = fnumFor(before);
  const b = fnumFor(after);
  return a.fnum !== b.fnum || a.block !== b.block;
}

/**
 * A 0-1 level as total level: seven bits of attenuation, 0.75 dB a step.
 *
 * The finest volume control on this board by a factor of eight, which is what
 * makes an FM part able to swell where a PSG one can only step. Silence is 127
 * rather than a key-off, so a fade need not restart the note.
 */
export function totalLevelFor(level: number): number {
  const clamped = level <= 0 ? 0 : level >= 1 ? 1 : level;
  if (clamped <= 0) return 0x7f;
  // 0.75 dB a step: 20·log10(level) / 0.75, floored at full attenuation. The
  // natural log and a constant, because a shared kernel is what makes the
  // register a browser writes the same one a CLI writes (doc 02 §Determinism).
  const db = (20 * math.log(clamped)) / LN10;
  const steps = Math.round(-db / 0.75);
  return steps < 0 ? 0 : steps > 0x7f ? 0x7f : steps;
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
