/**
 * The SN76489 binding (Master System, Game Gear, SG-1000).
 *
 * The simplest register map in the set and the hardest arrangement problem: the
 * chip has no envelope generator, so every volume shape is a write, and its tone
 * channels stop dead at ~109 Hz. Both facts are visible right here — volume is a
 * single latch byte, and a bass note below the floor has nowhere to go but the
 * periodic-noise channel or an octave up.
 *
 * The Game Gear's stereo port is register `0x06`; the plain part ignores it.
 */

import type { AudioSpec } from "@demake/core";

import { snapPitch, snapVolume } from "../pitch.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

const PSG_CLOCK = 3579545;
/** CPU cycles per scanline on the SMS/GG VDP — the line interrupt's period. */
const CYCLES_PER_LINE = 228;

export function psgBinding(console: string, spec: AudioSpec): ChipBinding {
  const stereo = spec.mixing.channels === 2;

  return {
    console,
    chips: spec.chips,
    spec,

    init(): BoundWrite[] {
      // Silence everything: four attenuation latches at full cut.
      return [
        { reg: 0, value: 0x9f },
        { reg: 0, value: 0xbf },
        { reg: 0, value: 0xdf },
        { reg: 0, value: 0xff },
        ...(stereo ? [{ reg: 0x06, value: 0xff }] : []),
      ];
    },

    encode(next, prev): BoundWrite[] {
      const writes: BoundWrite[] = [];
      let stereoByte = 0;
      let stereoChanged = prev === undefined;

      for (let i = 0; i < spec.channels.length; i += 1) {
        const channel = spec.channels[i]!;
        const frame = next[i]!;
        const before = prev?.[i];
        const isNoise = channel.kind === "noise";

        if (stereo) {
          const left = !frame.on ? false : (frame.pan?.left ?? true);
          const right = !frame.on ? false : (frame.pan?.right ?? true);
          if (left) stereoByte |= 0x10 << i;
          if (right) stereoByte |= 1 << i;
          if (
            before === undefined ||
            before.on !== frame.on ||
            before.pan?.left !== frame.pan?.left ||
            before.pan?.right !== frame.pan?.right
          ) {
            stereoChanged = true;
          }
        }

        const attenuation = frame.on ? 15 - snapVolume(channel.volume, frame.level) : 15;
        const beforeAttenuation =
          before === undefined
            ? -1
            : before.on
              ? 15 - snapVolume(channel.volume, before.level)
              : 15;

        if (isNoise) {
          // Control changes reset the shift register, so they are written only
          // when the colour actually changes or a new hit lands.
          const tonal = frame.noiseTonal === true;
          const rate = noiseRate(frame.noisePeriod ?? 1);
          const changed =
            before === undefined ||
            frame.retrigger === true ||
            before.noiseTonal !== frame.noiseTonal ||
            noiseRate(before.noisePeriod ?? 1) !== rate;
          if (changed && frame.on) {
            writes.push({ reg: 0, value: 0xe0 | (tonal ? 0 : 0x04) | rate });
          }
          if (attenuation !== beforeAttenuation) {
            writes.push({ reg: 0, value: 0xf0 | attenuation });
          }
          continue;
        }

        if (frame.on && channel.pitch) {
          const pitch = snapPitch(channel.pitch, frame.hz);
          const period = pitch.divider;
          const beforePeriod =
            before?.on && channel.pitch ? snapPitch(channel.pitch, before.hz).divider : -1;
          if (period !== beforePeriod) {
            writes.push({ reg: 0, value: 0x80 | (i << 5) | (period & 0x0f) });
            writes.push({ reg: 0, value: (period >> 4) & 0x3f });
          }
        }
        if (attenuation !== beforeAttenuation) {
          writes.push({ reg: 0, value: 0x90 | (i << 5) | attenuation });
        }
      }

      if (stereo && stereoChanged) writes.push({ reg: 0x06, value: stereoByte });
      return writes;
    },

    fitRate(desiredHz): DriverRateFit {
      // The VDP's line interrupt fires every (N+1) scanlines, which gives a far
      // finer set of rates than vblank and is how an SMS driver holds a tempo.
      let best: DriverRateFit | undefined;
      let bestError = Infinity;
      for (let n = 0; n <= 255; n += 1) {
        const den = CYCLES_PER_LINE * (n + 1);
        const hz = PSG_CLOCK / den;
        if (hz < 30 || hz > 800) continue;
        const error = Math.abs(hz - desiredHz);
        if (error < bestError - 1e-12) {
          bestError = error;
          best = { rate: { num: PSG_CLOCK, den }, source: "line-irq", divisor: n };
        }
      }
      if (best) return best;
      return { rate: spec.driver.frameRate, source: "vblank" };
    },
  };
}

/**
 * Map a noise-period index onto the chip's three rates plus tone-2 tracking.
 *
 * Index 0 is the deepest colour, which on this chip means following tone channel
 * 2 — the same trick that reaches below the tone channels' pitch floor.
 */
function noiseRate(index: number): number {
  const clamped = Math.round(index) < 0 ? 0 : Math.round(index);
  if (clamped >= 3) return 0;
  return 3 - clamped;
}
