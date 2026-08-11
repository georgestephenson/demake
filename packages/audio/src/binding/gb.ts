/**
 * The Game Boy binding.
 *
 * Four channels, and the driver's shape follows from two hardware facts:
 *
 * - **The envelope register only takes effect on a trigger.** So a volume change
 *   mid-note is `NRx2` followed by a re-trigger of `NRx4`. That is safe here
 *   because a DMG trigger does *not* reset the duty step — it reloads the
 *   frequency timer — so re-triggering every tick does not click. **The wave
 *   channel is the exception**: a trigger there resets the wave position, so its
 *   pitch writes carry the bit only when a note starts (`encodeWave`).
 * - **A silent channel with its DAC on still drives a level.** Note-off is
 *   therefore `NRx2 = 0`, powering the DAC down, rather than volume 0. Getting
 *   this wrong leaves four DC offsets sitting in the mix.
 *
 * The timer fit enumerates the real TAC/TMA combinations rather than pretending
 * any rate is reachable, which is what lets `arrange` report an honest tempo
 * error in parts per million.
 */

import type { AudioSpec } from "@demake/core";

import type { ChannelFrame } from "../chipscript.js";
import { snapPitch, snapVolume } from "../pitch.js";
import { panSides } from "./pan.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

const GB_CLOCK = 4194304;
/** TAC's four input clock dividers, in master clocks per timer step. */
const TAC_DIVIDERS = [1024, 16, 64, 256];

/** Register bases for the two pulse channels: NR10-block and NR20-block. */
const PULSE_BASE = [0x10, 0x15];

/**
 * Noise period index → (divisor code, shift).
 *
 * A flat index over the useful half of the space, ordered low-pitched to
 * high-pitched, so the arranger can pick "a deep thud" or "a thin tick" without
 * knowing the register layout. Shifts above 9 are omitted: they are inaudible
 * hiss rather than a usable drum colour.
 */
const NOISE_TABLE: readonly { divisor: number; shift: number }[] = (() => {
  const out: { divisor: number; shift: number }[] = [];
  for (let shift = 9; shift >= 0; shift -= 1) {
    for (let divisor = 7; divisor >= 0; divisor -= 1) out.push({ divisor, shift });
  }
  return out;
})();

export function gbBinding(console: string, spec: AudioSpec): ChipBinding {
  return {
    console,
    chips: spec.chips,
    spec,

    init(): BoundWrite[] {
      return [
        { reg: 0x26, value: 0x80 }, // APU on
        { reg: 0x24, value: 0x77 }, // both sides at full master volume
        { reg: 0x25, value: 0xff }, // every channel to both sides
        { reg: 0x12, value: 0x00 }, // DACs down until a note arrives
        { reg: 0x17, value: 0x00 },
        { reg: 0x1a, value: 0x00 },
        { reg: 0x21, value: 0x00 },
        ...waveRamWrites(),
      ];
    },

    encode(next, prev): BoundWrite[] {
      const writes: BoundWrite[] = [];
      let panning = 0;
      let panningChanged = prev === undefined;

      for (let i = 0; i < spec.channels.length; i += 1) {
        const channel = spec.channels[i]!;
        const frame = next[i]!;
        const before = prev?.[i];
        const bit = 1 << i;
        const sides = panSides(frame.pan);
        if (frame.on) {
          if (sides.left) panning |= bit << 4;
          if (sides.right) panning |= bit;
        }
        const wasSides = before === undefined ? undefined : panSides(before.pan);
        if (
          before === undefined ||
          before.on !== frame.on ||
          wasSides!.left !== sides.left ||
          wasSides!.right !== sides.right
        ) {
          panningChanged = true;
        }

        if (i === 0 || i === 1) encodePulse(writes, PULSE_BASE[i]!, channel, frame, before);
        else if (i === 2) encodeWave(writes, channel, frame, before);
        else encodeNoise(writes, frame, before);
      }

      if (panningChanged) writes.push({ reg: 0x25, value: panning });
      return writes;
    },

    fitRate(desiredHz): DriverRateFit {
      // Enumerate every TAC divider and TMA reload, and keep the closest. The
      // Game Boy's timer is coarse at high rates and fine at low ones, so the
      // best fit is not something a formula can shortcut.
      let best: DriverRateFit | undefined;
      let bestError = Infinity;
      for (const divider of TAC_DIVIDERS) {
        for (let tma = 0; tma <= 255; tma += 1) {
          const steps = 256 - tma;
          const num = GB_CLOCK;
          const den = divider * steps;
          const hz = num / den;
          if (hz < 16 || hz > 1024) continue;
          const error = Math.abs(hz - desiredHz);
          if (error < bestError - 1e-12) {
            bestError = error;
            best = { rate: { num, den }, source: "timer", divisor: tma };
          }
        }
      }
      if (best) return best;
      return { rate: { num: GB_CLOCK, den: 70224 }, source: "vblank" };
    },
  };
}

/** A default wavetable: one cycle of a stepped triangle, 32 nibbles. */
function waveRamWrites(): BoundWrite[] {
  const samples: number[] = [];
  for (let i = 0; i < 32; i += 1) {
    const up = i < 16 ? i : 31 - i;
    samples.push(up);
  }
  const writes: BoundWrite[] = [];
  for (let i = 0; i < 16; i += 1) {
    writes.push({ reg: 0x30 + i, value: (samples[i * 2]! << 4) | samples[i * 2 + 1]! });
  }
  return writes;
}

function encodePulse(
  writes: BoundWrite[],
  base: number,
  channel: {
    pitch?: Parameters<typeof snapPitch>[0];
    volume: Parameters<typeof snapVolume>[0];
    duties?: readonly number[];
  },
  frame: ChannelFrame,
  before: ChannelFrame | undefined,
): void {
  if (!frame.on) {
    if (before?.on !== false) writes.push({ reg: base + 2, value: 0x00 });
    return;
  }
  const pitch = snapPitch(channel.pitch!, frame.hz);
  const register = 2048 - pitch.divider;
  const volume = snapVolume(channel.volume, frame.level);
  const duty = frame.duty ?? 2;

  const retrigger = !before?.on || frame.retrigger === true;
  const dutyChanged = retrigger || before?.duty !== frame.duty;
  const volumeChanged = retrigger || snapVolume(channel.volume, before!.level) !== volume;
  const pitchChanged = retrigger || snapPitch(channel.pitch!, before!.hz).divider !== pitch.divider;

  if (dutyChanged) writes.push({ reg: base + 1, value: (duty << 6) | 0x3f });
  // Volume lives in the envelope register's initial-volume field with the
  // envelope itself switched off: the driver shapes the note, not the chip.
  if (volumeChanged) writes.push({ reg: base + 2, value: (volume << 4) | 0x00 });
  if (pitchChanged) writes.push({ reg: base + 3, value: register & 0xff });
  // NRx4 carries the trigger, so any change that needs one lands here.
  if (pitchChanged || volumeChanged || retrigger) {
    writes.push({ reg: base + 4, value: 0x80 | ((register >> 8) & 0x07) });
  }
}

function encodeWave(
  writes: BoundWrite[],
  channel: { pitch?: Parameters<typeof snapPitch>[0]; volume: Parameters<typeof snapVolume>[0] },
  frame: ChannelFrame,
  before: ChannelFrame | undefined,
): void {
  if (!frame.on) {
    if (before?.on !== false) writes.push({ reg: 0x1a, value: 0x00 });
    return;
  }
  const pitch = snapPitch(channel.pitch!, frame.hz);
  const register = 2048 - pitch.divider;
  // The wave channel's "volume" is a shift, so it has four levels, not sixteen.
  const level = snapVolume(channel.volume, frame.level);
  const shift = [0, 3, 2, 1][level] ?? 1;

  const retrigger = !before?.on;
  if (retrigger) writes.push({ reg: 0x1a, value: 0x80 });
  if (retrigger || snapVolume(channel.volume, before!.level) !== level) {
    writes.push({ reg: 0x1c, value: shift << 5 });
  }
  const pitchChanged = retrigger || snapPitch(channel.pitch!, before!.hz).divider !== pitch.divider;
  if (pitchChanged) {
    writes.push({ reg: 0x1d, value: register & 0xff });
    // The trigger belongs to the note, not to the pitch. NR34's bit 7 restarts
    // the wave position (`WaveChannel.trigger`), so carrying it on a bend
    // resets the waveform mid-note — the hazard `encodeNoise` below already
    // guards against on the shift register, one channel along. A vibrato is
    // several bends a second, and a chord the arranger reduces is one per
    // change of note, so this fires in the example library today: `keep.mid`
    // restarts the waveform 47 times and `vault.mid` 11.
    writes.push({ reg: 0x1e, value: (retrigger ? 0x80 : 0) | ((register >> 8) & 0x07) });
  }
}

function encodeNoise(
  writes: BoundWrite[],
  frame: ChannelFrame,
  before: ChannelFrame | undefined,
): void {
  if (!frame.on) {
    if (before?.on !== false) writes.push({ reg: 0x21, value: 0x00 });
    return;
  }
  // Percussion is struck, not held: the chip's own envelope shapes the decay
  // and the driver stays silent until the next hit. Writing every tick would
  // restart the shift register and turn a ringing snare into a buzz.
  if (!frame.retrigger && before?.on) return;

  const index = clampIndex(frame.noisePeriod ?? 40, NOISE_TABLE.length);
  const entry = NOISE_TABLE[index]!;
  const volume = Math.round((frame.level < 0 ? 0 : frame.level > 1 ? 1 : frame.level) * 15);
  const width = frame.noiseTonal ? 0x08 : 0x00;
  const envelope = clampIndex(frame.envelopePeriod ?? 2, 8);

  writes.push({ reg: 0x21, value: (volume << 4) | envelope });
  writes.push({ reg: 0x22, value: (entry.shift << 4) | width | entry.divisor });
  writes.push({ reg: 0x23, value: 0x80 });
}

function clampIndex(value: number, length: number): number {
  const index = Math.round(value);
  return index < 0 ? 0 : index >= length ? length - 1 : index;
}

/** How many noise colours this binding offers, for the arranger's drum map. */
export const GB_NOISE_PERIODS = NOISE_TABLE.length;
