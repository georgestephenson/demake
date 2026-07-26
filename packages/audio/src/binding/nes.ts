/**
 * The NES 2A03 binding.
 *
 * Two things shape it, and both are hardware facts rather than choices:
 *
 * - **`$4015` is a shared enable mask**, so gating a channel is a write that
 *   belongs to no single channel. This is precisely why a binding is per-console
 *   rather than per-channel.
 * - **Writing a pulse's `$4003`/`$4007` resets its sequencer phase.** Doing that
 *   every tick would click at the driver rate, so the high byte is written only
 *   when it changes or a note actually starts.
 *
 * The triangle has no volume register at all: it is gated through `$4015` and
 * nothing else, which is what makes it a bass voice that cannot be shaped.
 */

import type { AudioSpec } from "@demake/core";

import type { ChannelFrame } from "../chipscript.js";
import { snapPitch, snapVolume } from "../pitch.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

const NES_CLOCK = 1789773;
/** Pulse 1, pulse 2, triangle, noise register bases (offsets from $4000). */
const BASE = [0x00, 0x04, 0x08, 0x0c];

export function nesBinding(console: string, spec: AudioSpec): ChipBinding {
  return {
    console,
    chips: spec.chips,
    spec,

    init(): BoundWrite[] {
      return [
        { reg: 0x15, value: 0x00 }, // everything disabled
        { reg: 0x17, value: 0x40 }, // 4-step frame counter, IRQ inhibited
        { reg: 0x00, value: 0x30 }, // constant volume 0 on both pulses
        { reg: 0x04, value: 0x30 },
        { reg: 0x08, value: 0xff }, // triangle linear counter held on
        { reg: 0x0c, value: 0x30 },
      ];
    },

    encode(next, prev): BoundWrite[] {
      const writes: BoundWrite[] = [];
      let enable = 0;
      let enableChanged = prev === undefined;

      for (let i = 0; i < spec.channels.length; i += 1) {
        const channel = spec.channels[i]!;
        const frame = next[i]!;
        const before = prev?.[i];
        if (frame.on) enable |= 1 << i;
        if (before === undefined || before.on !== frame.on) enableChanged = true;

        if (i === 0 || i === 1) encodePulse(writes, BASE[i]!, channel, frame, before);
        else if (i === 2) encodeTriangle(writes, channel, frame, before);
        else encodeNoise(writes, channel, frame, before);
      }

      // The enable mask is written *first* when a channel is coming on, so its
      // length counter is armed before the note's own registers land.
      if (enableChanged) writes.unshift({ reg: 0x15, value: enable });
      return writes;
    },

    fitRate(desiredHz): DriverRateFit {
      // The NES has no general-purpose timer a music driver can rely on without
      // burning the DMC channel, so the honest answer is vblank plus the
      // groove table `planTiming` builds on top of it.
      const frame = spec.driver.frameRate;
      const frameHz = frame.num / frame.den;
      // Integer multiples of the frame rate are reachable by simply doing more
      // work per frame, which is how a driver gets finer timing resolution.
      const multiple = Math.max(1, Math.round(desiredHz / frameHz));
      return { rate: { num: frame.num * multiple, den: frame.den }, source: "vblank" };
    },
  };
}

type Channel = AudioSpec["channels"][number];

function encodePulse(
  writes: BoundWrite[],
  base: number,
  channel: Channel,
  frame: ChannelFrame,
  before: ChannelFrame | undefined,
): void {
  const volume = frame.on ? snapVolume(channel.volume, frame.level) : 0;
  const beforeVolume = before?.on ? snapVolume(channel.volume, before.level) : 0;
  const duty = frame.duty ?? 2;
  const retrigger = frame.on && (!before?.on || frame.retrigger === true);

  if (retrigger || volume !== beforeVolume || (before?.duty ?? 2) !== duty) {
    // Bit 5 halts the length counter and bit 4 selects constant volume: the
    // driver owns the envelope, so the chip's own must stay out of the way.
    writes.push({ reg: base, value: (duty << 6) | 0x30 | volume });
  }
  if (!frame.on || !channel.pitch) return;

  const period = snapPitch(channel.pitch, frame.hz).divider - 1;
  const beforePeriod =
    before?.on && channel.pitch ? snapPitch(channel.pitch, before.hz).divider - 1 : -1;
  if (period === beforePeriod && !retrigger) return;
  writes.push({ reg: base + 2, value: period & 0xff });
  if (retrigger || period >> 8 !== beforePeriod >> 8) {
    // The length index is maximal because the driver decides note ends.
    writes.push({ reg: base + 3, value: ((period >> 8) & 0x07) | (0x1f << 3) });
  }
}

function encodeTriangle(
  writes: BoundWrite[],
  channel: Channel,
  frame: ChannelFrame,
  before: ChannelFrame | undefined,
): void {
  if (!frame.on || !channel.pitch) return;
  const period = snapPitch(channel.pitch, frame.hz).divider - 1;
  const beforePeriod =
    before?.on && channel.pitch ? snapPitch(channel.pitch, before.hz).divider - 1 : -1;
  if (period === beforePeriod) return;
  writes.push({ reg: 0x0a, value: period & 0xff });
  writes.push({ reg: 0x0b, value: ((period >> 8) & 0x07) | (0x1f << 3) });
}

function encodeNoise(
  writes: BoundWrite[],
  channel: Channel,
  frame: ChannelFrame,
  before: ChannelFrame | undefined,
): void {
  if (!frame.on) return;
  if (!frame.retrigger && before?.on) return;
  const volume = snapVolume(channel.volume, frame.level);
  // Index 0 is the deepest colour everywhere in this package; the NES's own
  // table runs the other way, so it is reversed here rather than in the caller.
  const index = clamp(Math.round(frame.noisePeriod ?? 8), 0, 15);
  const mode = frame.noiseTonal ? 0x80 : 0x00;
  writes.push({ reg: 0x0c, value: 0x30 | volume });
  writes.push({ reg: 0x0e, value: mode | (15 - index) });
  writes.push({ reg: 0x0f, value: 0x1f << 3 });
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Exposed for the timing planner: the NES's usable driver clock. */
export const NES_CPU_HZ = NES_CLOCK;
