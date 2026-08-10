/**
 * The Nintendo DS binding.
 *
 * Sixteen channels of nearly identical hardware, which makes this the widest
 * encoder in the set and — after the Super Nintendo's — the simplest, for the
 * same reason: almost nothing is shared, so almost nothing has to be negotiated.
 *
 *   - **There is no shared register at all.** Not a `NR51`, not a `$4015`, not
 *     even a key-on pulse: a channel's volume, panning, pitch, waveform and start
 *     bit are its own bytes and no other channel can see them. The master volume
 *     is written once at boot and never again, so two streams sharing this chip
 *     never write the same register and the driver emits no merge routine —
 *     which of the seven consoles with a driver only the Master System and the
 *     Mega Drive can also say, and they say it by having *less* hardware rather
 *     than more.
 *   - **A note starts with the control byte, and it starts everything.** The top
 *     bit of one byte latches the source, the format and the repeat mode and
 *     begins playback, so it is written *last* — after the waveform, the timer,
 *     the volume and the panning — and a note-off is that same byte cleared.
 *   - **Panning is a level.** Seven bits of position, so `pan` is one byte rather
 *     than two bits of a shared one, and centre is a value rather than the
 *     absence of a choice.
 *   - **Three kinds of channel, one lattice.** A channel's timer is a period
 *     whatever it is doing; what differs is what a period *is* — a sample for the
 *     eight sample players, an eighth of a cycle for the six duty generators, one
 *     shift for the two noise channels. So the spec's three `step` values are the
 *     whole of the difference, and this file snaps all three the same way.
 *
 * The clock is the ARM7's own timer rather than the picture's, because on this
 * console the driver is not on the game's processor at all: `fitRate` enumerates
 * prescaler and reload exactly as the Game Boy Advance's does, over the same four
 * prescalers and a system clock twice as fast.
 */

import type { AudioSpec } from "@demake/core";
import {
  NDS_CH,
  NDS_CHANNEL_STRIDE,
  NDS_FIRST_NOISE_CHANNEL,
  NDS_FIRST_PSG_CHANNEL,
  NDS_MASTER_ENABLE,
  NDS_MASTER_VOLUME as NDS_MASTER_VOLUME_REG,
  NDS_SPU_CHANNELS,
} from "@demake/chip";

import { snapPitch, snapVolume } from "../pitch.js";

import {
  NDS_MASTER_VOLUME,
  NDS_PSG_DIVIDER,
  NDS_WAVE_WORDS,
  waveAddress,
  type NdsWaveform,
} from "./nds-bank.js";
import { panGains } from "./pan.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

/** The ARM7's system clock, which its timers count. */
const ARM7_CLOCK = 33513982;

/** What each of the four prescaler settings divides that clock by. */
const PRESCALERS = [1, 64, 256, 1024] as const;

/** Panning positions: hard left, centre, hard right, in the register's units. */
const PAN = { left: 0, centre: 64, right: 127 } as const;

/**
 * A position as this chip's panning byte.
 *
 * Seven bits with centre at 64, so the widest palette in the set is also the
 * finest placement in it: a voice sits at any of a hundred and twenty-seven
 * points across the image, and nothing is shared with another channel, so
 * moving one costs one byte and disturbs nothing. Centre is exactly 64, which
 * is what a part the arranger does not place has always been given.
 */
function panRegister(pan: number | undefined): number {
  // Read off the *attenuated* side rather than the position, so this stays
  // expressed through the same taper every other level-panning chip uses: the
  // near side holds at full and the far one falls away, and how far it has
  // fallen is how far from centre the voice sits. Taking it off `pan` directly
  // would be a second statement of the law, and the two could drift.
  const gains = panGains(pan);
  const toRight = 1 - gains.left;
  const toLeft = 1 - gains.right;
  const value =
    toRight > 0
      ? PAN.centre + Math.round(toRight * (PAN.right - PAN.centre))
      : PAN.centre - Math.round(toLeft * PAN.centre);
  return value < PAN.left ? PAN.left : value > PAN.right ? PAN.right : value;
}

/**
 * The control byte's fields.
 *
 * Duty in the low three bits, then the repeat mode, then the format, then the
 * start bit — the low byte of a word `SOUNDxCNT` whose upper three bytes are the
 * volume, the divider and the panning. That the four things a note needs are four
 * separate bytes is what keeps a note-on to five writes on a chip whose registers
 * are nominally words.
 */
const CONTROL = {
  /** Repeat forever, which is what a single-cycle waveform wants. */
  loop: 1 << 3,
  /** Eight-bit PCM, which is what the built-in bank is. */
  pcm8: 0 << 5,
  /** The duty generator on channels 8–13, the noise register on 14–15. */
  psg: 3 << 5,
  start: 0x80,
} as const;

/** The base register of one channel's block. */
function channelBase(index: number): number {
  return index * NDS_CHANNEL_STRIDE;
}

/**
 * Which built-in waveform a sample channel plays, by its declared kind.
 *
 * The spec fixes the kinds precisely so this table can exist: the hardware has no
 * opinion about what a sample player is for, so the *demaker* decides once and
 * the driver's bank is known at build time. The Super Nintendo binding's rule,
 * and the Game Boy Advance's after it.
 */
function waveformFor(kind: string, duty: number | undefined): NdsWaveform {
  if (kind === "pulse") {
    const index = duty === undefined ? 2 : Math.max(0, Math.min(2, Math.round(duty)));
    return (["pulse12", "pulse25", "pulse50"] as const)[index] as NdsWaveform;
  }
  if (kind === "wave") return "triangle";
  return "saw";
}

/**
 * A noise period index as the channel's timer period.
 *
 * Sixty-four steps of a semitone-ish each, an octave every eight, from a shift
 * rate near a Game Boy's fastest down through eight octaves. It is a table and a
 * shift rather than a power, because a chip binding may not reach for a
 * transcendental (doc 16 §Determinism engineering) and because the lattice a
 * demaker indexes against should be the same lattice on every engine.
 */
const NOISE_MANTISSA = [256, 279, 304, 332, 362, 395, 431, 470] as const;

function noisePeriod(index: number): number {
  const clamped = index < 0 ? 0 : index > 63 ? 63 : Math.round(index);
  const period = (32 * (NOISE_MANTISSA[clamped & 7] as number)) << (clamped >> 3);
  return Math.max(1, Math.min(0xffff, period >> 8));
}

/** The period a frame asks a channel for, in the channel's own units. */
function periodFor(
  channel: AudioSpec["channels"][number],
  frame: { hz: number; noisePeriod?: number },
): number {
  if (channel.kind === "noise") return noisePeriod(frame.noisePeriod ?? 20);
  return snapPitch(channel.pitch!, frame.hz).divider;
}

/** The control byte that starts a channel, given what it is playing. */
function controlFor(index: number, kind: string, duty: number | undefined): number {
  if (index >= NDS_FIRST_NOISE_CHANNEL) return CONTROL.psg | CONTROL.loop | CONTROL.start;
  if (index >= NDS_FIRST_PSG_CHANNEL) {
    // Seven of the eight duty settings are a square wave and the eighth is a
    // constant, so a request is clamped rather than wrapped: a note asking for
    // more than 87.5% gets the widest pulse the chip has, not silence.
    const wanted = duty === undefined ? 3 : Math.max(0, Math.min(6, Math.round(duty)));
    return wanted | CONTROL.psg | CONTROL.loop | CONTROL.start;
  }
  void kind;
  return CONTROL.pcm8 | CONTROL.loop | CONTROL.start;
}

export function ndsBinding(console: string, spec: AudioSpec): ChipBinding {
  if (spec.channels.length > NDS_SPU_CHANNELS) {
    throw new Error(
      `this chip has ${NDS_SPU_CHANNELS} channels and the spec declares ${spec.channels.length}`,
    );
  }

  return {
    console,
    chips: spec.chips,
    spec,

    init(): BoundWrite[] {
      const writes: BoundWrite[] = [];
      for (let index = 0; index < spec.channels.length; index += 1) {
        const base = channelBase(index);
        const channel = spec.channels[index]!;
        // Stopped, silent and centred. The control byte goes first so nothing
        // below it is written into a channel that is still running.
        writes.push({ reg: base + NDS_CH.control, value: 0 });
        writes.push({ reg: base + NDS_CH.volume, value: 0 });
        // A square wave is full scale on this hardware and a built-in waveform is
        // a quarter of it, so the duty and noise channels run permanently on ÷4
        // and the two halves of the palette are the same loudness
        // (`nds-bank.ts` §PEAK). Nothing writes this register again.
        writes.push({
          reg: base + NDS_CH.divider,
          value: index >= NDS_FIRST_PSG_CHANNEL ? NDS_PSG_DIVIDER : 0,
        });
        writes.push({ reg: base + NDS_CH.panning, value: PAN.centre });
        if (index >= NDS_FIRST_PSG_CHANNEL) continue;
        // A sample channel's source, loop point and length are the same for every
        // waveform in the bank — same address page, same length, no loop offset —
        // so all but the low byte of the address are stated once here and a note
        // changes one byte. The driver copies the bank to that page at boot.
        const address = waveAddress(waveformFor(channel.kind, 0));
        writes.push({ reg: base + NDS_CH.source + 1, value: (address >> 8) & 0xff });
        writes.push({ reg: base + NDS_CH.source + 2, value: (address >> 16) & 0xff });
        writes.push({ reg: base + NDS_CH.source + 3, value: (address >> 24) & 0xff });
        writes.push({ reg: base + NDS_CH.loop, value: 0 });
        writes.push({ reg: base + NDS_CH.loop + 1, value: 0 });
        writes.push({ reg: base + NDS_CH.length, value: NDS_WAVE_WORDS & 0xff });
        writes.push({ reg: base + NDS_CH.length + 1, value: (NDS_WAVE_WORDS >> 8) & 0xff });
        writes.push({ reg: base + NDS_CH.length + 2, value: 0 });
      }
      // The master volume and the enable, last, so the chip comes up with every
      // channel already silent rather than with whatever a reset left behind.
      writes.push({ reg: NDS_MASTER_VOLUME_REG, value: NDS_MASTER_VOLUME });
      writes.push({ reg: NDS_MASTER_ENABLE, value: 0x80 });
      return writes;
    },

    encode(next, prev): BoundWrite[] {
      const writes: BoundWrite[] = [];

      for (let index = 0; index < spec.channels.length; index += 1) {
        const channel = spec.channels[index]!;
        const frame = next[index]!;
        const before = prev?.[index];
        const base = channelBase(index);

        if (!frame.on) {
          // Stopping is one byte and it is the whole of note-off: the channel
          // stops advancing, so nothing is left driving a level and nothing is
          // left running under a silent volume to come back at a random phase.
          if (before?.on !== false) writes.push({ reg: base + NDS_CH.control, value: 0 });
          continue;
        }

        const retrigger = !before?.on || frame.retrigger === true;
        const level = snapVolume(channel.volume, frame.level);
        const pan = panRegister(frame.pan);
        const period = periodFor(channel, frame);
        const timer = (0x10000 - period) & 0xffff;

        if (retrigger) {
          // A restart re-reads everything the control byte latches, so the
          // channel is stopped first — starting a channel that is already started
          // does nothing at all on this hardware, which would leave the note
          // playing the last one's waveform.
          writes.push({ reg: base + NDS_CH.control, value: 0 });
          if (index < NDS_FIRST_PSG_CHANNEL) {
            const address = waveAddress(waveformFor(channel.kind, frame.duty));
            writes.push({ reg: base + NDS_CH.source, value: address & 0xff });
          }
        }

        const beforePeriod = before?.on ? periodFor(channel, before) : -1;
        if (retrigger || beforePeriod !== period) {
          writes.push({ reg: base + NDS_CH.timer, value: timer & 0xff });
          writes.push({ reg: base + NDS_CH.timer + 1, value: (timer >> 8) & 0xff });
        }
        if (retrigger || snapVolume(channel.volume, before!.level) !== level) {
          writes.push({ reg: base + NDS_CH.volume, value: level & 0x7f });
        }
        const beforePan = before?.on ? panRegister(before.pan) : -1;
        if (retrigger || beforePan !== pan) {
          writes.push({ reg: base + NDS_CH.panning, value: pan });
        }
        if (retrigger) {
          writes.push({
            reg: base + NDS_CH.control,
            value: controlFor(index, channel.kind, frame.duty),
          });
        }
      }
      return writes;
    },

    fitRate(desiredHz): DriverRateFit {
      // The ARM7 has four timers and nothing else in a demade cartridge uses one,
      // so the driver takes timer zero: sixteen bits of reload against a four-way
      // prescaler, over a clock twice the Game Boy Advance's.
      let best: DriverRateFit | undefined;
      let bestError = Infinity;
      for (const [index, prescale] of PRESCALERS.entries()) {
        for (let steps = 1; steps <= 0x10000; steps += 1) {
          const den = prescale * steps;
          const hz = ARM7_CLOCK / den;
          if (hz < 16 || hz > 4096) continue;
          const error = Math.abs(hz - desiredHz);
          if (error < bestError - 1e-12) {
            bestError = error;
            // The register holds the *reload*, which is what the counter starts
            // from and therefore the complement of the count; the prescaler rides
            // above it, exactly as the Game Boy Advance's fit packs it.
            best = {
              rate: { num: ARM7_CLOCK, den },
              source: "timer",
              divisor: ((0x10000 - steps) & 0xffff) | (index << 16),
            };
          }
          // Below the desired rate the error only grows, so stop this prescaler.
          if (hz < desiredHz) break;
        }
      }
      if (best) return best;
      return { rate: spec.driver.frameRate, source: "vblank" };
    },
  };
}

/**
 * Which channel a register write belongs to, one bit per channel.
 *
 * Sixteen bits, which is more than the packed run format's field holds — and that
 * is deliberate, because this tag is not the packed one. It is what `restrict`
 * asks when it cuts an effect down to the channel it borrowed, and there the mask
 * is an ordinary number: an effect's opening tick states every channel it is
 * *not* using as well, and those writes have to be dropped or the music's bass
 * stops each time a coin is collected. {@link ndsPackTag} is the four-bit one the
 * driver reads.
 *
 * No latch anywhere on this chip, so the factory carries no state — it is a
 * factory because one chip in the set needs it to be.
 */
export function ndsChannelTag(): (reg: number, value: number, chip?: number) => number {
  return (reg: number): number => {
    if (reg >= NDS_SPU_CHANNELS * NDS_CHANNEL_STRIDE) return 0;
    return 1 << ((reg / NDS_CHANNEL_STRIDE) | 0);
  };
}

/**
 * The tag the *packed data* carries: the channels an effect may take, and
 * nothing else.
 *
 * Sixteen channels against a four-bit field, and they do not have to fit — the
 * Mega Drive's answer to the same arithmetic, and for the same reason. What
 * preemption asks is whether an effect may be using a channel, so only the
 * channels effects were placed on are numbered and everything else tags zero,
 * which the driver reads as "never skip this". Fourteen voices of a track
 * therefore play *through* a sound effect instead of ducking for it.
 */
export function ndsPackTag(
  stealable: readonly number[],
): () => (reg: number, value: number, chip: number) => number {
  return () => {
    const full = ndsChannelTag();
    return (reg: number, value: number, chip: number): number => {
      const mask = full(reg, value, chip);
      if (mask === 0) return 0;
      for (let index = 0; index < stealable.length; index += 1) {
        if (mask === 1 << (stealable[index] as number)) return 1 << index;
      }
      return 0;
    };
  };
}
