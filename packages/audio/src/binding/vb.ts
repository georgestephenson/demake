/**
 * The Virtual Boy binding.
 *
 * Six wavetable voices, which makes this the WonderSwan's encoder with two more
 * channels — and then four things that are genuinely this chip's:
 *
 *   - **There is no shared register.** Panning is two nibbles in the channel's
 *     own byte, enabling is its own bit 7, and the one global register is a
 *     panic button rather than a mixer. So this console emits **no merge routine
 *     at all** — the sixth in the matrix, and the fourth whose reason is that its
 *     hardware shares *less* rather than more (doc 16 §`NR51` is merged).
 *   - **Level and panning are different registers.** Output is
 *     `sample × envelope × side`, two multiplies rather than one, so this
 *     binding puts the **note's level in the envelope register** and the
 *     **pan in the level register** — which means a volume step is one write and
 *     a pan change is another, and neither disturbs the other. Every other
 *     wavetable console in the set packs both into one byte and rewrites it for
 *     either.
 *   - **The envelope is hardware, and it is used.** Four bits stepping down on
 *     the chip's own clock with a repeat bit, so a drum's decay is *programmed*
 *     rather than written every tick — `frame.envelopePeriod` reaches the chip
 *     instead of reaching the driver. That is the Game Boy's arrangement on a
 *     wavetable machine, which neither the PC Engine nor the WonderSwan can do.
 *   - **The pitch register counts the wrong way**, like the WonderSwan's: it is
 *     subtracted from 2048, so a larger value is a higher note. The spec declares
 *     the lattice and this file does the subtraction.
 *
 * The clock is the frame, at **50.2 Hz** — the slowest in the matrix. The
 * console has a hardware timer whose interrupt a *standalone* cartridge could
 * ride, and the spec lists it; what a game gets is `gameDriverRate`'s answer,
 * which is the frame, because a game's main loop is already waiting for one.
 *
 * Source: the Virtual Boy *Sacred Tech Scroll* — VSU registers.
 */

import { math, type AudioSpec } from "@demake/core";
import { VSU_CHANNELS, VSU_NOISE_CHANNEL, VSU_REG, Vsu } from "@demake/chip";

import type { ChannelFrame } from "../chipscript.js";
import { snapPitch, snapVolume } from "../pitch.js";

import { vbBankWrites, vbTableFor } from "./vb-bank.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

/** Noise tap modes the register offers. */
const NOISE_MODES = 8;

/** The divider a drum sits on at the ends of the shared percussion scale. */
const NOISE_DIVIDER_LOW = 2048;
const NOISE_DIVIDER_HIGH = 64;

/** Envelope steps a second at the fastest interval, which is 3.84 ms. */
const ENVELOPE_STEPS_PER_SECOND = 1000 / 3.84;

/**
 * A noise index on the shared 0–63 percussion scale, as this chip's tap mode.
 *
 * The WonderSwan's arrangement to the bit — same fifteen-bit register, same
 * eight taps, same reversal, because the hardware's own order runs longest
 * sequence first and a low drum index wants the long one.
 */
function noiseTap(index: number): number {
  const clamped = Math.round(index) < 0 ? 0 : Math.round(index);
  const scaled = Math.round((clamped * (NOISE_MODES - 1)) / 63);
  return NOISE_MODES - 1 - (scaled > NOISE_MODES - 1 ? NOISE_MODES - 1 : scaled);
}

/** The same index as this chip's noise *pitch*, which is the channel's divider. */
function noiseDivider(index: number): number {
  const clamped = index < 0 ? 0 : index > 63 ? 63 : Math.round(index);
  const ratio = math.pow(NOISE_DIVIDER_HIGH / NOISE_DIVIDER_LOW, clamped / 63);
  const divider = Math.round(NOISE_DIVIDER_LOW * ratio);
  return divider < 1 ? 1 : divider > NOISE_DIVIDER_LOW ? NOISE_DIVIDER_LOW : divider;
}

/** The eleven-bit register a frame asks a pitched channel for. */
function registerFor(channel: AudioSpec["channels"][number], hz: number): number {
  const divider = snapPitch(channel.pitch!, hz).divider;
  const value = 2048 - divider;
  return value < 0 ? 0 : value > 0x7ff ? 0x7ff : value;
}

/** `LRV`: which sides this frame is heard on, at full — the pan and nothing else. */
function panByte(frame: ChannelFrame): number {
  const left = frame.pan?.left ?? true;
  const right = frame.pan?.right ?? true;
  return ((left ? 0x0f : 0) << 4) | (right ? 0x0f : 0);
}

/**
 * `EV0`: the note's level, its direction, and the interval it steps at.
 *
 * A frame with no envelope period is a held level: direction down and interval
 * zero, with `EV1` leaving the envelope *disabled* so nothing moves. A frame
 * that asks for a decay programs the interval and `EV1` switches the envelope
 * on, and the chip does the rest — which is the whole reason this console's
 * drums cost a driver one write rather than one a tick.
 */
function envelopeByte(channel: AudioSpec["channels"][number], frame: ChannelFrame): number {
  const level = snapVolume(channel.volume, frame.level);
  const period = frame.envelopePeriod;
  if (period === undefined || period <= 0) return (level << 4) & 0xf0;
  // The interval is `(n + 1) × 3.84 ms` a step, and a decay from full is fifteen
  // steps — so the interval that empties the envelope in `period` seconds is
  // this, clamped to the three bits the register has.
  const steps = Math.max(1, Math.round(period * ENVELOPE_STEPS_PER_SECOND) / 15);
  const interval = Math.max(0, Math.min(7, Math.round(steps) - 1));
  return ((level << 4) & 0xf0) | interval;
}

/** Whether this frame wants the hardware envelope running. */
function envelopeOn(frame: ChannelFrame): boolean {
  return frame.envelopePeriod !== undefined && frame.envelopePeriod > 0;
}

export function vbBinding(console: string, spec: AudioSpec): ChipBinding {
  if (spec.channels.length > VSU_CHANNELS) {
    throw new Error(
      `this chip has ${VSU_CHANNELS} channels and the spec declares ${spec.channels.length}`,
    );
  }
  const noiseIndex = spec.channels.findIndex((channel) => channel.kind === "noise");
  if (noiseIndex >= 0 && noiseIndex !== VSU_NOISE_CHANNEL) {
    // One shift register, wired to channel six: a spec that put the kit anywhere
    // else would arrange a part onto hardware that cannot play it.
    throw new Error(
      `this chip's noise generator is channel ${VSU_NOISE_CHANNEL + 1}; the spec puts it on channel ${noiseIndex + 1}`,
    );
  }

  /** Which waveform table each channel plays, decided once. */
  const tables = ((): number[] => {
    const seen = new Map<string, number>();
    return spec.channels.map((channel) => {
      const ordinal = seen.get(channel.kind) ?? 0;
      seen.set(channel.kind, ordinal + 1);
      return vbTableFor(channel.kind, ordinal);
    });
  })();

  const base = (index: number, reg: number): number => Vsu.channelBase(index) + reg;

  return {
    console,
    chips: spec.chips,
    spec,

    init(): BoundWrite[] {
      // The five waveform tables, and then every channel silent with its own
      // table selected. There is no output stage to configure and no shared
      // enable to clear — this chip's whole global state is one stop bit.
      const writes: BoundWrite[] = [{ reg: 0x580, value: 0x01 }, ...vbBankWrites()];
      for (let index = 0; index < spec.channels.length; index += 1) {
        writes.push({ reg: base(index, VSU_REG.INT), value: 0x00 });
        writes.push({ reg: base(index, VSU_REG.LRV), value: 0x00 });
        writes.push({ reg: base(index, VSU_REG.FQL), value: 0x00 });
        writes.push({ reg: base(index, VSU_REG.FQH), value: 0x00 });
        writes.push({ reg: base(index, VSU_REG.EV0), value: 0x00 });
        writes.push({ reg: base(index, VSU_REG.EV1), value: 0x00 });
        if (index !== VSU_NOISE_CHANNEL) {
          writes.push({ reg: base(index, VSU_REG.RAM), value: tables[index] as number });
        }
      }
      return writes;
    },

    encode(next, prev): BoundWrite[] {
      const out: BoundWrite[] = [];
      for (let index = 0; index < spec.channels.length; index += 1) {
        const channel = spec.channels[index]!;
        const frame = next[index]!;
        const before = prev?.[index];

        if (!frame.on) {
          // Silence is the channel's own enable bit and its own level. Both,
          // because a channel a preempting effect hands back would otherwise be
          // left sounding at the effect's level (doc 16 §Give a borrowed channel
          // back) — and here both registers belong to the channel alone, so
          // there is nothing to merge on the way.
          if (before?.on !== false) {
            out.push({ reg: base(index, VSU_REG.EV0), value: 0x00 });
            out.push({ reg: base(index, VSU_REG.INT), value: 0x00 });
          }
          continue;
        }

        const retrigger = !before?.on || frame.retrigger === true;

        if (channel.kind === "noise") {
          const tap = noiseTap(frame.noisePeriod ?? 20);
          const beforeTap = before?.on ? noiseTap(before.noisePeriod ?? 20) : -1;
          if (retrigger || beforeTap !== tap) {
            out.push({
              reg: base(index, VSU_REG.EV1),
              value: (tap << 4) | (envelopeOn(frame) ? 1 : 0),
            });
          }
        }

        const register =
          channel.kind === "noise"
            ? 2048 - noiseDivider(frame.noisePeriod ?? 20)
            : registerFor(channel, frame.hz);
        const beforeRegister = !before?.on
          ? -1
          : channel.kind === "noise"
            ? 2048 - noiseDivider(before.noisePeriod ?? 20)
            : registerFor(channel, before.hz);
        if (retrigger || beforeRegister !== register) {
          out.push({ reg: base(index, VSU_REG.FQL), value: register & 0xff });
          out.push({ reg: base(index, VSU_REG.FQH), value: (register >> 8) & 0x07 });
        }

        const pan = panByte(frame);
        if (retrigger || (before?.on === true && panByte(before) !== pan)) {
          out.push({ reg: base(index, VSU_REG.LRV), value: pan });
        }

        const envelope = envelopeByte(channel, frame);
        if (retrigger || (before?.on === true && envelopeByte(channel, before) !== envelope)) {
          out.push({ reg: base(index, VSU_REG.EV0), value: envelope });
        }

        if (channel.kind !== "noise") {
          const wants = envelopeOn(frame) ? 1 : 0;
          const had = before?.on === true ? (envelopeOn(before) ? 1 : 0) : -1;
          if (retrigger || had !== wants) {
            out.push({ reg: base(index, VSU_REG.EV1), value: wants });
          }
        }

        // The enable is last and it is the retrigger: writing bit 7 restarts the
        // waveform at sample zero and reloads the envelope, so a note-on is one
        // register write once everything it plays with is already in place.
        if (retrigger) out.push({ reg: base(index, VSU_REG.INT), value: 0x80 });
      }
      return out;
    },

    fitRate(): DriverRateFit {
      // The frame and only the frame for a game, at the slowest rate in the
      // matrix. The hardware timer the spec also lists is a standalone
      // cartridge's, on the Mega Drive's terms.
      return { rate: spec.driver.frameRate, source: "vblank" };
    },
  };
}

/**
 * Which channel a register write belongs to.
 *
 * Arithmetic rather than a table, because this chip's address space *is* the
 * channel index: every channel register is `$400 + channel × $40 + offset`, so
 * one shift answers it. The waveform tables and the stop register belong to no
 * channel and tag zero, which is what lets a boot's hundred and sixty waveform
 * writes sit in a stream a preempting effect never skips.
 *
 * No latch and no factory: unlike the PC Engine's this chip selects nothing, so
 * the tag is a pure function of the address.
 */
export function vbChannelTag(): (reg: number, value: number, chip?: number) => number {
  return (reg: number): number => {
    if (reg < 0x400 || reg >= 0x400 + VSU_CHANNELS * 0x40) return 0;
    return 1 << ((reg - 0x400) >> 6);
  };
}
