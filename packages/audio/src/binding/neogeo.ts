/**
 * The Neo Geo binding: fourteen voices in four sections, on one chip.
 *
 * The widest binding in the set, and the first whose channels do not resemble
 * each other at all — four FM voices, three squares, six fixed-rate sample voices
 * and one variable-rate one, each with its own register block, its own volume law
 * and its own idea of what a note is. So this file is four encoders under one
 * `encode`, and almost nothing is shared between them.
 *
 * ### The FM half is the Mega Drive's, and that is the hardware
 *
 * OPNB and OPN2 are one FM core, so `patchWrites`, `pitchWrites` and the key-on
 * encoding are `fm-patch.ts`'s called rather than restated — as the Mega Drive
 * calls `psgBinding` rather than reimplementing an SN76489. What this console
 * supplies is a **channel map and a clock**. {@link FM_SLOT} is `[1, 2, 4, 5]`,
 * which is not a convention anybody chose: those are the four OPN channels this
 * part wires out, and running them through the shared `ymKey` encoding reproduces
 * exactly the `001`, `010`, `101`, `110` the hardware documentation lists. A
 * mapping that had to be corrected afterwards would be a sign the two chips were
 * merely similar.
 *
 * ### …but it has no LFO, so vibrato is written rather than switched on
 *
 * The one place the OPNB is *less* than the OPN2 in a way a binding can feel.
 * A Mega Drive programs `$22` and a sensitivity nibble and the chip bends the
 * note itself; this part has neither, so `lfoChannels` is absent here and
 * `compile.ts` moves the pitch every tick instead (doc 17 §Vibrato). That costs
 * real schedule bytes — on the Mega Drive hardware vibrato is a few per cent
 * over a dry track and here it is the same two-to-five times every other
 * console pays.
 *
 * It is worth stating rather than leaving to be rediscovered, because the
 * failure mode of getting it wrong is silent: write `$22` and the FMS bits on
 * this chip and `ym2610.ts` *refuses* them by design — so the schedule looks
 * like it is asking for vibrato, the per-tick pitch writes are gone because the
 * binding claimed to handle it, and the note simply comes out straight.
 *
 * ### This console has no shared register, and the reason is per section
 *
 * Six of the fifteen consoles emit no merge routine and each has its own reason.
 * Here there are two, both of them the hardware's:
 *
 *   - **An SSG note is silenced by its own level.** The mixer at `$07` is the one
 *     byte three channels share, and it is written *once* at boot — tone on,
 *     noise off — because a channel at volume zero is silent whatever the mixer
 *     says. Nothing in the schedule touches it, so there is nothing to fold.
 *   - **The ADPCM key-on byte is a pulse.** `$00` on the second port starts the
 *     voices its mask names and does nothing to the rest, which is the Super
 *     Nintendo's `KON` on completely different hardware — so a driver masks it
 *     rather than merging two shadows of it.
 *
 * What that costs is the SSG's noise source, which the spec declares and nothing
 * here reaches (doc 13 §A5.5). It is the right trade rather than a gap to be
 * embarrassed about: this console has *six* sample voices playing recordings of
 * drums, so putting a hi-hat on a shift register would be spending the machine
 * downwards.
 *
 * ### The driver's clock is the schedule's, so `$27` is never written
 *
 * The Mega Drive's standalone cartridge has to strip its boot prefix because the
 * binding's `$27 = 0` would switch off the timer the driver rides. Here that is
 * not a workaround to remember, it is a rule: on this console the timer is the
 * *only* clock a driver has, so it belongs to the driver and the schedule never
 * states it. {@link neogeoBinding}'s `init` writes every other global.
 *
 * Sources:
 * - Neo Geo Development Wiki — YM2610 registers, FM, SSG, ADPCM
 * - Yamaha — YM2610 Application Manual and Application Manual II
 */

import { math, type AudioChannelSpec, type AudioSpec } from "@demake/core";

import type { ChannelFrame } from "../chipscript.js";

import {
  carriersOf,
  fnumAt,
  type FmBindingOptions,
  patchWrites,
  pitchWrites,
  totalLevelFor,
  type FmPatch,
} from "./fm-patch.js";
import {
  adpcmABank,
  adpcmBBank,
  drumFor,
  waveformFor,
  NEOGEO_WAVE_SAMPLES,
  type NeogeoWaveform,
} from "./neogeo-bank.js";
import { panSides } from "./pan.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

/** The chip's clock, and the divider that makes its internal sample rate. */
const YM_CLOCK = 8000000;
const YM_SAMPLE_DIVIDER = 144;

/**
 * Where each section starts in the spec's channel list.
 *
 * The squares come first, which is the spec's decision and not an accident of
 * listing order: `sfx` places an effect on the first channel with a pitch, and on
 * this console that should be a square — the four FM voices belong to the music,
 * and keeping effects off them keeps the FM key-on byte off the preemption path.
 */
export const SSG_FIRST = 0;
export const SSG_CHANNELS = 3;
export const FM_FIRST = 3;
export const FM_CHANNELS = 4;
export const ADPCM_A_FIRST = 7;
export const ADPCM_A_CHANNELS = 6;
export const ADPCM_B_CHANNEL = 13;

/**
 * Which OPN channel each of this part's four FM voices is.
 *
 * Not a numbering this project chose: the `$30`-`$B6` block is addressed at
 * per-channel offsets 1 and 2 on each of the two ports, with offset 0 absent, so
 * the four voices *are* the six-channel core's channels 1, 2, 4 and 5. Feeding
 * these through `fm-patch.ts`'s shared encoding produces the `001`, `010`, `101`,
 * `110` key-on codes the hardware documentation lists, which is the check that
 * says the map is the hardware's rather than a guess.
 */
export const FM_SLOT: readonly number[] = [1, 2, 4, 5];

/** The natural log of ten, for this file's one decibel conversion. */
const LN10 = 2.302585092994046;

/** What the arranger hands the binding beyond the frames. */
export type NeogeoBindingOptions = FmBindingOptions;

/** Build the Neo Geo's binding. */
export function neogeoBinding(
  console: string,
  spec: AudioSpec,
  options: NeogeoBindingOptions = {},
): ChipBinding {
  const patches = options.patches ?? [];
  const installed: (FmPatch | undefined)[] = new Array(FM_CHANNELS).fill(undefined) as undefined[];

  return {
    console,
    chips: spec.chips,
    spec,

    init(): BoundWrite[] {
      const out: BoundWrite[] = [];
      // Not `$27`: on this console the FM timer is the driver's only clock, so it
      // belongs to the driver and never to the schedule (§The driver's clock).
      for (let channel = 0; channel < FM_CHANNELS; channel += 1) {
        out.push(...ymKey(channel, 0));
        out.push(...ymChannel(channel, 0xb4, 0xc0));
        for (let position = 0; position < 4; position += 1) {
          out.push(...ymChannel(channel, 0x40 + position * 4, 0x7f));
        }
      }
      // The SSG mixer, written here and nowhere else: all three tones enabled,
      // noise on none of them. A note is silenced by its level.
      out.push(...portA(0x07, 0x38));
      for (let channel = 0; channel < SSG_CHANNELS; channel += 1) {
        out.push(...portA(0x08 + channel, 0));
      }
      // Every sample voice stopped, and the shared attenuator wide open — the
      // per-voice level is what a note rides.
      out.push(...portB(0x00, 0xbf));
      out.push(...portB(0x01, 0x3f));
      out.push(...portA(0x10, 0x01)); // ADPCM-B reset
      installed.fill(undefined);
      return out;
    },

    encode(next, prev): BoundWrite[] {
      const out: BoundWrite[] = [];
      for (let index = 0; index < FM_CHANNELS; index += 1) {
        const at = FM_FIRST + index;
        encodeFm(out, index, next[at]!, prev?.[at], patches[index], installed);
      }
      for (let index = 0; index < SSG_CHANNELS; index += 1) {
        encodeSsg(out, index, next[SSG_FIRST + index]!, prev?.[SSG_FIRST + index]);
      }
      let keyOn = 0;
      let keyOff = 0;
      for (let index = 0; index < ADPCM_A_CHANNELS; index += 1) {
        const at = ADPCM_A_FIRST + index;
        const started = encodeAdpcmA(out, index, next[at]!, prev?.[at]);
        if (started === "on") keyOn |= 1 << index;
        if (started === "off") keyOff |= 1 << index;
      }
      // Two pulses, and never a merge: each names the voices it acts on and leaves
      // every other voice exactly as it was.
      if (keyOff !== 0) out.push(...portB(0x00, 0x80 | keyOff));
      if (keyOn !== 0) out.push(...portB(0x00, keyOn));
      encodeAdpcmB(
        out,
        spec.channels[ADPCM_B_CHANNEL]!,
        next[ADPCM_B_CHANNEL]!,
        prev?.[ADPCM_B_CHANNEL],
      );
      return out;
    },

    fitRate(desiredHz): DriverRateFit {
      // A timer and only a timer: this console's sound processor cannot see the
      // picture, so unlike every other `fitRate` in the set there is no frame
      // candidate to beat. Timer A counts the chip's own sample period — ten bits
      // of it — so its floor is 54 Hz and 120 Hz lands on count 463, which is
      // 119.99 Hz: the most exact driver tick in the matrix.
      //
      // Timer B is not searched. It counts eight times slower over eight bits, so
      // the only thing it adds is 27-54 Hz, and every rate a driver would ask for
      // is inside timer A's range — one timer is a simpler driver and a `divisor`
      // that needs no second field to say which register it means.
      let best: DriverRateFit = {
        rate: { num: YM_CLOCK, den: YM_SAMPLE_DIVIDER * 1024 },
        source: "timer",
        divisor: 0,
      };
      let bestError = Infinity;
      const tickRate = YM_CLOCK / YM_SAMPLE_DIVIDER;
      for (let reload = 0; reload < 1024; reload += 1) {
        const count = 1024 - reload;
        const hz = tickRate / count;
        if (hz < 54 || hz > 800) continue;
        const error = Math.abs(hz - desiredHz);
        if (error < bestError - 1e-12) {
          bestError = error;
          best = {
            rate: { num: YM_CLOCK, den: YM_SAMPLE_DIVIDER * count },
            source: "timer",
            divisor: reload,
          };
        }
      }
      return best;
    },
  };
}

// --- the bus -------------------------------------------------------------------

/**
 * One register write, as the two bus writes it really is.
 *
 * `reg` is a *port* rather than a register number, exactly as it is on the Mega
 * Drive and for the same reason: a driver stores an address and then a datum, and
 * the four addresses are Z80 ports `$04`-`$07`.
 */
function bus(port: 0 | 1, address: number, value: number): BoundWrite[] {
  return [
    { reg: port * 2, value: address },
    { reg: port * 2 + 1, value },
  ];
}

/** A register on the first port pair: the SSG, ADPCM-B, and FM channels 1-2. */
function portA(address: number, value: number): BoundWrite[] {
  return bus(0, address, value);
}

/** A register on the second pair: ADPCM-A, and FM channels 3-4. */
function portB(address: number, value: number): BoundWrite[] {
  return bus(1, address, value);
}

/** A per-channel FM register, through the shared core's own addressing. */
function ymChannel(channel: number, address: number, value: number): BoundWrite[] {
  const slot = FM_SLOT[channel] as number;
  return bus(slot < 3 ? 0 : 1, address + (slot % 3), value);
}

/** Key on or off, which lives on the first port pair for every channel. */
function ymKey(channel: number, slots: number): BoundWrite[] {
  const slot = FM_SLOT[channel] as number;
  const encoded = slot < 3 ? slot : slot + 1;
  return bus(0, 0x28, (slots << 4) | encoded);
}

// --- FM ------------------------------------------------------------------------

/** Signal slot to the position it occupies in the register map. */
const REGISTER_POSITION: readonly number[] = [0, 2, 1, 3];

function fnumFor(hz: number): { fnum: number; block: number } {
  return fnumAt(hz, YM_CLOCK / YM_SAMPLE_DIVIDER);
}

/**
 * One FM voice's writes for this tick — the Mega Drive's encoder at this clock.
 *
 * Order is the hardware's: install the patch if it changed, set the carriers'
 * level, set the pitch, then key. A key-on before the pitch sounds the previous
 * note for a tick, which is a click on every note of a fast line.
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
    out.push(...remap(patchWrites(wanted, FM_SLOT[channel] as number)));
    installed[channel] = wanted;
    before = undefined;
  }

  if (!frame.on) {
    if (before === undefined || before.on) out.push(...ymKey(channel, 0));
    return;
  }

  const pitch = fnumFor(frame.hz);
  const changed = before === undefined || !before.on || fnumChanged(before.hz, frame.hz);
  const retrigger = frame.retrigger === true || before === undefined || !before.on;

  const level = totalLevelFor(frame.level);
  const beforeLevel = before?.on === true ? totalLevelFor(before.level) : -1;
  if (level !== beforeLevel) {
    for (const slot of carriersOf(wanted.algorithm)) {
      out.push(...ymChannel(channel, 0x40 + (REGISTER_POSITION[slot] as number) * 4, level));
    }
  }

  // Two output bits and nothing between, exactly as on the Mega Drive's OPN2 —
  // every one of this chip's four sections pans by switch, which is why none of
  // them calls `panGains`.
  const sides = panSides(frame.pan);
  const panBits = (sides.left ? 0x80 : 0) | (sides.right ? 0x40 : 0);
  const wasSides = panSides(before?.pan);
  const beforePan =
    before?.on === true ? (wasSides.left ? 0x80 : 0) | (wasSides.right ? 0x40 : 0) : -1;
  if (panBits !== beforePan) out.push(...ymChannel(channel, 0xb4, panBits));

  if (changed) {
    out.push(...remap(pitchWrites(FM_SLOT[channel] as number, pitch.fnum, pitch.block)));
  }
  if (retrigger) {
    out.push(...ymKey(channel, 0));
    out.push(...ymKey(channel, 0x0f));
  }
}

/** The shared encoder emits `{reg, value}` pairs already; this widens the type. */
function remap(writes: readonly { reg: number; value: number }[]): BoundWrite[] {
  return writes.map((write) => ({ reg: write.reg, value: write.value }));
}

function fnumChanged(before: number, after: number): boolean {
  const a = fnumFor(before);
  const b = fnumFor(after);
  return a.fnum !== b.fnum || a.block !== b.block;
}

// --- SSG -----------------------------------------------------------------------

/**
 * One square's writes: a twelve-bit period and a four-bit level.
 *
 * There is no retrigger to do. Writing a period does not restart the counter on
 * this family, so a repeated note is a level write and nothing else — which is
 * why this encoder is a third the length of the FM one beside it, and why the
 * hardware envelope stays out of it: an envelope that cannot be told to hold is
 * no use to a melodic line.
 */
function encodeSsg(
  out: BoundWrite[],
  channel: number,
  frame: ChannelFrame,
  before: ChannelFrame | undefined,
): void {
  const level = frame.on ? ssgLevel(frame.level) : 0;
  const beforeLevel = before === undefined ? -1 : before.on ? ssgLevel(before.level) : 0;
  if (frame.on) {
    const period = ssgPeriod(frame.hz);
    const beforePeriod = before?.on === true ? ssgPeriod(before.hz) : -1;
    if (period !== beforePeriod) {
      out.push(...portA(channel * 2, period & 0xff));
      out.push(...portA(channel * 2 + 1, (period >> 8) & 0x0f));
    }
  }
  if (level !== beforeLevel) out.push(...portA(0x08 + channel, level));
}

/** `period = 250000 / hz`, which is the crystal over three, halved, over sixteen. */
function ssgPeriod(hz: number): number {
  if (!(hz > 0)) return 4095;
  const raw = Math.round(YM_CLOCK / 32 / hz);
  return raw < 1 ? 1 : raw > 4095 ? 4095 : raw;
}

/**
 * A 0-1 level as one of sixteen steps about 3 dB apart, *rising*.
 *
 * The inverse of the SN76489's, which is the mistake a driver written from that
 * chip would make: fifteen is loud here and zero is silence.
 */
function ssgLevel(level: number): number {
  const clamped = level <= 0 ? 0 : level >= 1 ? 1 : level;
  if (clamped <= 0) return 0;
  const db = (20 * math.log(clamped)) / LN10;
  const steps = Math.round(-db / 3);
  const value = 15 - steps;
  return value < 0 ? 0 : value > 15 ? 15 : value;
}

// --- ADPCM-A -------------------------------------------------------------------

/**
 * One drum voice's writes, and what the tick should do to the key-on mask.
 *
 * A voice is *started* rather than held: it plays its recording to the end and
 * stops itself, so a tick that is neither a hit nor a release emits nothing at
 * all. That is the whole difference between a sample drum and a noise generator
 * shaped by an envelope, and it is why this console's percussion costs about
 * three register writes a hit where a Game Boy's costs three a *tick*.
 */
function encodeAdpcmA(
  out: BoundWrite[],
  voice: number,
  frame: ChannelFrame,
  before: ChannelFrame | undefined,
): "on" | "off" | "none" {
  if (!frame.on) {
    // A voice that was never on has nothing to release, and `init` has already
    // dumped all six — so the first tick of a track says nothing about five
    // silent drums rather than keying them off one by one.
    return before?.on === true ? "off" : "none";
  }
  if (before?.on === true && frame.retrigger !== true) return "none";

  const bank = adpcmABank();
  const region = bank.regions[drumFor(frame.hz)];
  const sides = panSides(frame.pan);
  const bits = (sides.left ? 0x80 : 0) | (sides.right ? 0x40 : 0);
  out.push(...portB(0x08 + voice, bits | adpcmALevel(frame.level)));
  out.push(...portB(0x10 + voice, region.startBlock & 0xff));
  out.push(...portB(0x18 + voice, (region.startBlock >> 8) & 0xff));
  out.push(...portB(0x20 + voice, region.endBlock & 0xff));
  out.push(...portB(0x28 + voice, (region.endBlock >> 8) & 0xff));
  return "on";
}

/** Five bits, `$1F` loudest, in 1.5 dB steps — twice the FM's coarseness. */
function adpcmALevel(level: number): number {
  const clamped = level <= 0 ? 0 : level >= 1 ? 1 : level;
  if (clamped <= 0) return 0;
  const db = (20 * math.log(clamped)) / LN10;
  const steps = Math.round(-db / 1.5);
  const value = 0x1f - steps;
  return value < 0 ? 0 : value > 0x1f ? 0x1f : value;
}

// --- ADPCM-B -------------------------------------------------------------------

/**
 * The one sample voice that has a pitch, which makes it a melodic channel.
 *
 * Its rate is a phase increment rather than a divider — `55555 × ΔN / 65536` —
 * so a cycle of a built-in waveform per note turns that into a note, and the
 * lattice is uniform in *frequency*: the bass quantises here where every
 * divider-based channel in the set crowds at the bottom and thins at the top.
 */
function encodeAdpcmB(
  out: BoundWrite[],
  channel: AudioChannelSpec,
  frame: ChannelFrame,
  before: ChannelFrame | undefined,
): void {
  if (!frame.on) {
    // Reset rather than a volume of zero: this voice is looping a waveform, so
    // leaving it running would keep a note under the rest for as long as the
    // track lasts.
    if (before === undefined || before.on) out.push(...portA(0x10, 0x01));
    return;
  }
  const retrigger = before === undefined || !before.on || frame.retrigger === true;
  const shape = waveformFor(channel.kind, frame.duty);
  const beforeShape = before?.on === true ? waveformFor(channel.kind, before.duty) : undefined;
  if (retrigger || shape !== beforeShape) {
    const region = adpcmBBank().regions[shape];
    out.push(...portA(0x12, region.startBlock & 0xff));
    out.push(...portA(0x13, (region.startBlock >> 8) & 0xff));
    out.push(...portA(0x14, region.endBlock & 0xff));
    out.push(...portA(0x15, (region.endBlock >> 8) & 0xff));
  }

  const delta = deltaFor(frame.hz);
  if (retrigger || (before?.on === true && deltaFor(before.hz) !== delta)) {
    out.push(...portA(0x19, delta & 0xff));
    out.push(...portA(0x1a, (delta >> 8) & 0xff));
  }

  const sides = panSides(frame.pan);
  const bits = (sides.left ? 0x80 : 0) | (sides.right ? 0x40 : 0);
  const wasSides = panSides(before?.pan);
  const beforeBits =
    before?.on === true ? (wasSides.left ? 0x80 : 0) | (wasSides.right ? 0x40 : 0) : -1;
  if (bits !== beforeBits) out.push(...portA(0x11, bits));

  const volume = Math.round(Math.max(0, Math.min(1, frame.level)) * 255);
  const beforeVolume =
    before?.on === true ? Math.round(Math.max(0, Math.min(1, before.level)) * 255) : -1;
  if (volume !== beforeVolume) out.push(...portA(0x1b, volume));

  // Start with repeat, last, so the voice already knows what it is playing.
  if (retrigger) out.push(...portA(0x10, 0x90));
}

/** `ΔN = hz × cycleSamples × 65536 / 55555`, clamped to sixteen bits. */
function deltaFor(hz: number): number {
  const rate = YM_CLOCK / YM_SAMPLE_DIVIDER;
  const raw = Math.round((hz * NEOGEO_WAVE_SAMPLES * 65536) / rate);
  return raw < 1 ? 1 : raw > 0xffff ? 0xffff : raw;
}

/** A named waveform's region, exported so the ROM builder lays the same bytes. */
export function neogeoWaveformRegion(shape: NeogeoWaveform): { start: number; end: number } {
  const region = adpcmBBank().regions[shape];
  return { start: region.startBlock, end: region.endBlock };
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
