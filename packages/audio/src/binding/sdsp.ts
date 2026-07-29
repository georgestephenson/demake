/**
 * The Super Nintendo binding.
 *
 * Eight voices of identical hardware, which makes this the simplest register
 * encoder in the set and the one with the most to say about *why*:
 *
 *   - **Nothing is shared, so nothing has to be merged.** A Game Boy's `NR51`
 *     carries every channel's panning and an NES's `$4015` every channel's
 *     enable; here a voice's volume, pitch, waveform and envelope are its own ten
 *     bytes and no other voice can see them. The one byte two streams could both
 *     want is `KON`, and it is a *pulse* — writing it keys the voices whose bits
 *     are set and does nothing to the rest — so the driver masks it to what the
 *     stream still owns rather than folding two shadows.
 *   - **Level goes in `GAIN`, not in the volume registers.** `VOL(L)`/`VOL(R)`
 *     hold the panning and change almost never; `GAIN` in its direct mode is one
 *     byte that *is* the level, so a note's whole dynamic shape costs one write a
 *     tick. Note-off is `GAIN = 0` for the same reason, which also avoids `KOF` —
 *     the only other byte two streams would have had to share.
 *   - **A note starts with a waveform, not a duty bit.** `SRCN` selects one of
 *     the built-in single-cycle samples (`sdsp-bank.ts`), so a pulse channel's
 *     duty and a wave channel's shape are the same mechanism.
 *
 * The tick rate comes from the sound processor's own timer rather than from the
 * picture, which is the other thing this console does not share with any of the
 * others: `fitRate` enumerates 8000/N and finds most musical rates exactly.
 */

import type { AudioSpec } from "@demake/core";

import type { ChannelFrame } from "../chipscript.js";
import { snapPitch, snapVolume } from "../pitch.js";

import { ARAM_DIR_PAGE, MASTER_VOLUME, sampleNumber, type Waveform } from "./sdsp-bank.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

/** Global register addresses the binding writes. */
export const SDSP_REG = {
  mvolL: 0x0c,
  mvolR: 0x1c,
  kon: 0x4c,
  kof: 0x5c,
  flg: 0x6c,
  pmon: 0x2d,
  non: 0x3d,
  eon: 0x4d,
  dir: 0x5d,
} as const;

/** Timer 0 and 1 count a prescaler at this rate; the divisor does the rest. */
const TIMER_HZ = 8000;

/**
 * Which built-in waveform each channel plays, by the channel's declared kind.
 *
 * The spec fixes the kinds precisely so this table can exist: the hardware has
 * no opinion, so the *demaker* decides once and the driver's sample bank is known
 * at build time.
 */
function waveformFor(kind: string, duty: number | undefined): Waveform {
  if (kind === "pulse") {
    const index = duty === undefined ? 2 : Math.max(0, Math.min(2, Math.round(duty)));
    return (["pulse12", "pulse25", "pulse50"] as const)[index] as Waveform;
  }
  if (kind === "triangle") return "triangle";
  return "saw";
}

/**
 * Which voices a register write belongs to.
 *
 * A plain function of the register for everything except `KON`, whose value *is*
 * a set of voices. No latch anywhere on this chip, so the factory `data.ts` asks
 * for carries no state — it is a factory because one chip in the set needs it to
 * be, not because they all do.
 */
export function sdspChannelTag(): (reg: number, value: number) => number {
  return (reg: number, value: number): number => {
    if (reg === SDSP_REG.kon) return value & 0xff;
    // `FLG`'s noise clock belongs to the one voice `NON` selects, and the spec
    // declares exactly one for that reason.
    if (reg === SDSP_REG.flg) return 1 << NOISE_VOICE;
    if ((reg & 0x0f) <= 0x09) return 1 << ((reg >> 4) & 0x07);
    return 0;
  };
}

/** The voice the spec's `noise` channel is, which `NON` and `FLG` follow. */
export const NOISE_VOICE = 7;

/** `KON` is masked rather than stored when two streams share the chip. */
export const SDSP_MERGE_REGS: ReadonlySet<number> = new Set([SDSP_REG.kon]);

export function sdspBinding(console: string, spec: AudioSpec): ChipBinding {
  return {
    console,
    chips: spec.chips,
    spec,

    init(): BoundWrite[] {
      const writes: BoundWrite[] = [
        // Come out of the reset the chip powers up in, with the noise generator
        // stopped: `FLG`'s low bits are the noise clock and zero is "never".
        { reg: SDSP_REG.flg, value: 0x00 },
        { reg: SDSP_REG.mvolL, value: MASTER_VOLUME },
        { reg: SDSP_REG.mvolR, value: MASTER_VOLUME },
        { reg: SDSP_REG.dir, value: ARAM_DIR_PAGE },
        // No echo, no pitch modulation, and the noise generator routed to the one
        // voice the spec calls a noise channel.
        { reg: SDSP_REG.eon, value: 0x00 },
        { reg: SDSP_REG.pmon, value: 0x00 },
        { reg: SDSP_REG.non, value: 1 << NOISE_VOICE },
        // Release every voice once, so nothing is left keyed from a soft reset.
        { reg: SDSP_REG.kof, value: 0xff },
        { reg: SDSP_REG.kof, value: 0x00 },
      ];
      for (let voice = 0; voice < spec.channels.length; voice += 1) {
        const base = voice << 4;
        // `ADSR1` bit 7 clear puts the voice on `GAIN`, which is where the driver
        // shapes the note itself — the chip's envelope generator is reserved for
        // percussion, where a decay the driver does not have to write is free.
        writes.push({ reg: base + 0x05, value: 0x00 });
        writes.push({ reg: base + 0x07, value: 0x00 });
        writes.push({ reg: base + 0x00, value: 0x00 });
        writes.push({ reg: base + 0x01, value: 0x00 });
      }
      return writes;
    },

    encode(next, prev): BoundWrite[] {
      const writes: BoundWrite[] = [];
      let keyOn = 0;

      for (let index = 0; index < spec.channels.length; index += 1) {
        const channel = spec.channels[index]!;
        const frame = next[index]!;
        const before = prev?.[index];
        const base = index << 4;

        if (!frame.on) {
          // Silence is a gain of zero rather than a key-off: it takes effect on
          // the sample, needs no shared register, and leaves the voice ready.
          if (before?.on !== false) writes.push({ reg: base + 0x07, value: 0x00 });
          continue;
        }

        const retrigger = !before?.on || frame.retrigger === true;
        const level = snapVolume(channel.volume, frame.level);
        const left = frame.pan?.left ?? true;
        const right = frame.pan?.right ?? true;

        if (channel.kind === "noise") {
          // Percussion is the one voice whose level lives in the volume
          // registers, because its `GAIN` is carrying the chip's own decay.
          if (!retrigger && before?.on) continue;
          encodeNoise(writes, base, frame, left ? level : 0, right ? level : 0);
          keyOn |= 1 << index;
          continue;
        }

        if (retrigger || before?.pan?.left !== frame.pan?.left) {
          writes.push({ reg: base + 0x00, value: left ? 0x7f : 0x00 });
        }
        if (retrigger || before?.pan?.right !== frame.pan?.right) {
          writes.push({ reg: base + 0x01, value: right ? 0x7f : 0x00 });
        }

        const pitch = snapPitch(channel.pitch!, frame.hz).divider;
        const previousPitch = before?.on ? snapPitch(channel.pitch!, before.hz).divider : -1;
        const waveform = waveformFor(channel.kind, frame.duty);
        if (retrigger || waveformFor(channel.kind, before?.duty) !== waveform) {
          writes.push({ reg: base + 0x04, value: sampleNumber(waveform) });
        }
        if (retrigger || previousPitch !== pitch) {
          writes.push({ reg: base + 0x02, value: pitch & 0xff });
          writes.push({ reg: base + 0x03, value: (pitch >> 8) & 0x3f });
        }
        if (retrigger || snapVolume(channel.volume, before!.level) !== level) {
          writes.push({ reg: base + 0x07, value: level & 0x7f });
        }
        if (retrigger) keyOn |= 1 << index;
      }

      // One `KON` for the whole tick, last, so every voice it starts has already
      // been told what to play. A pulse register, so it is never written when
      // nothing starts.
      if (keyOn !== 0) writes.push({ reg: SDSP_REG.kon, value: keyOn });
      return writes;
    },

    fitRate(desiredHz): DriverRateFit {
      // Timer 0 counts an 8 kHz prescaler down by an eight-bit divisor, and a
      // divisor of zero means 256 — so the reachable rates are 8000/N for N in
      // 1…256, and most musical driver rates land on one exactly.
      let best: DriverRateFit = {
        rate: { num: TIMER_HZ, den: 64 },
        source: "spc-timer",
        divisor: 64,
      };
      let bestError = Infinity;
      for (let divisor = 1; divisor <= 256; divisor += 1) {
        const hz = TIMER_HZ / divisor;
        if (hz < 32 || hz > 500) continue;
        const error = Math.abs(hz - desiredHz);
        if (error < bestError - 1e-12) {
          bestError = error;
          best = {
            rate: { num: TIMER_HZ, den: divisor },
            source: "spc-timer",
            // The register holds the divisor, and zero is how it says 256.
            divisor: divisor & 0xff,
          };
        }
      }
      return best;
    },
  };
}

/**
 * Percussion, which is the one place the chip's own envelope earns its keep.
 *
 * A hit is struck and left to ring: `GAIN`'s exponential-decrease mode falls on
 * its own, so the driver writes three bytes when the drum is hit and nothing at
 * all while it decays. Writing every tick instead would restart the noise
 * generator's rate and turn a ringing snare into a buzz — the same trap the Game
 * Boy's noise encoder documents.
 */
function encodeNoise(
  writes: BoundWrite[],
  base: number,
  frame: ChannelFrame,
  levelLeft: number,
  levelRight: number,
): void {
  const period = clampIndex(frame.noisePeriod ?? 20, 32);
  // `FLG`'s low five bits are the noise clock; the reset and mute bits above
  // them stay clear, so this is a plain store rather than a read-modify-write.
  writes.push({ reg: SDSP_REG.flg, value: period });
  writes.push({ reg: base + 0x00, value: levelLeft });
  writes.push({ reg: base + 0x01, value: levelRight });
  // Exponential decrease: `%101rrrrr`, with the rate from the frame's envelope
  // period spread across the useful half of the table.
  const decay = 24 - clampIndex(frame.envelopePeriod ?? 2, 8);
  writes.push({ reg: base + 0x07, value: 0xa0 | (decay & 0x1f) });
}

function clampIndex(value: number, length: number): number {
  const index = Math.round(value);
  return index < 0 ? 0 : index >= length ? length - 1 : index;
}
