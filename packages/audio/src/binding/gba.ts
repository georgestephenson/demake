/**
 * The Game Boy Advance binding.
 *
 * The second two-chip console in the set and the first whose two chips are
 * different *kinds* of thing: four Game Boy channels that generate their own
 * waveform, and beside them a software mixer that plays samples. So this file is
 * two encoders rather than one, and three decisions are worth stating.
 *
 *   - **The Game Boy half is `gb.ts`, called rather than restated.** The same
 *     four channels, the same envelopes, the same `NR51` — at addresses of their
 *     own, which is the *machine's* business and not the binding's (a
 *     `ChipScript` holds a Game Boy's register numbers and `Gba.apuRegister`
 *     maps them). A second copy of that encoder is how the two consoles would
 *     quietly stop agreeing about what a demade pulse sounds like.
 *   - **The mixer has no shared register worth merging.** A voice's source,
 *     step and two levels are its own five bytes and no other voice can see
 *     them; the one byte two streams could both want is `KON`, and it is a
 *     *pulse* — writing it starts the voices whose bits are set and does nothing
 *     to the rest — so a driver masks it to what the stream still owns rather
 *     than folding two shadows. That is the S-DSP's arrangement, reached by a
 *     mixer this project wrote rather than by hardware Sony did.
 *   - **Level is a per-side byte, so panning and dynamics are the same write.**
 *     There is no separate volume register and no envelope generator on this
 *     half at all: a note's whole shape is `VOLL`/`VOLR` a tick, which is what
 *     makes the mixer's six voices cost the driver two bytes each rather than
 *     ten.
 *
 * The clock is the console's own timer rather than the picture's — four of them,
 * two spoken for by the converters — so `fitRate` enumerates prescaler and
 * reload and finds most musical rates to within a fraction of a per cent.
 */

import type { AudioSpec } from "@demake/core";
import { GBA_PCM_KON, GBA_PCM_VOICES } from "@demake/chip";

import { snapPitch } from "../pitch.js";

import { gbBinding } from "./gb.js";
import { panGains } from "./pan.js";
import { sampleNumber, WAVE_SAMPLES, type Waveform } from "./gba-bank.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

/** Channels the Game Boy half owns, which are the first of the spec's. */
export const GBA_APU_CHANNELS = 4;

/** The system clock a driver's timer counts. */
const GBA_CLOCK = 16777216;

/** What each of the four prescaler settings divides that clock by. */
const PRESCALERS = [1, 64, 256, 1024] as const;

/** The mixer's output rate, which its pitch lattice is measured against. */
const PCM_RATE = 32768;

/**
 * How loud the four Game Boy channels sit against the mixer.
 *
 * A fact about the *board* rather than about either device — the same APU is the
 * whole output on a Game Boy — so it is stated on both sides of the seam and
 * neither model knows it. `@demake/gba`'s `PSG_MIX_GAIN` is the other statement,
 * and `packages/audio/test` pins the two together.
 */
export const GBA_PSG_GAIN = 0.35;

/** Register numbers inside the mixer's file, per voice. */
const VOICE_STRIDE = 8;
const REG_SRCN = 0;
const REG_STEP0 = 2;
const REG_VOLL = 5;
const REG_VOLR = 6;

/**
 * Which built-in waveform a channel plays, by its declared kind.
 *
 * The spec fixes the kinds precisely so this table can exist: the mixer has no
 * opinion, so the *demaker* decides once and the driver's bank is known at build
 * time. The S-DSP binding's rule, and for the same reason.
 */
function waveformFor(kind: string, duty: number | undefined): Waveform {
  if (kind === "noise") return "noise";
  if (kind === "pulse") {
    const index = duty === undefined ? 2 : Math.max(0, Math.min(2, Math.round(duty)));
    return (["pulse12", "pulse25", "pulse50"] as const)[index] as Waveform;
  }
  return "triangle";
}

/**
 * The 16.16 step that plays a waveform at a frequency.
 *
 * `hz × cycleSamples / rate`, which is the pitch lattice's `multiplier` form
 * read the other way round — and it is exact rather than snapped, because the
 * register is twenty-four bits against a lattice 0.03 Hz apart. This is the one
 * channel in the project where the *demaker* rather than the hardware decides
 * how close a note lands.
 */
function stepFor(hz: number, samples: number): number {
  const step = Math.round((hz * samples * 65536) / PCM_RATE);
  return Math.max(0, Math.min(0xffffff, step));
}

/** Eight bits of level, scaled from the frame's 0…1 and clamped. */
function levelByte(level: number, gain: number): number {
  if (gain <= 0) return 0;
  const value = Math.round(level * gain * 255);
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

export function gbaBinding(console: string, spec: AudioSpec): ChipBinding {
  const apuSpec: AudioSpec = { ...spec, channels: spec.channels.slice(0, GBA_APU_CHANNELS) };
  const apu = gbBinding(console, apuSpec);
  const pcmChannels = spec.channels.slice(GBA_APU_CHANNELS);
  if (pcmChannels.length > GBA_PCM_VOICES) {
    throw new Error(
      `the mixer runs ${GBA_PCM_VOICES} voices and the spec declares ${pcmChannels.length}`,
    );
  }

  return {
    console,
    chips: spec.chips,
    spec,
    chipGains: [GBA_PSG_GAIN, 1],

    init(): BoundWrite[] {
      const writes: BoundWrite[] = apu.init().map((write) => ({ ...write, chip: 0 }));
      // The mixer comes up with every voice silent and pointing at the first
      // waveform. Nothing is keyed, so nothing sounds until a note arrives.
      for (let voice = 0; voice < pcmChannels.length; voice += 1) {
        const base = voice * VOICE_STRIDE;
        writes.push({ reg: base + REG_SRCN, value: 0, chip: 1 });
        writes.push({ reg: base + REG_VOLL, value: 0, chip: 1 });
        writes.push({ reg: base + REG_VOLR, value: 0, chip: 1 });
      }
      return writes;
    },

    encode(next, prev): BoundWrite[] {
      const writes: BoundWrite[] = apu
        .encode(
          next.slice(0, GBA_APU_CHANNELS),
          prev === undefined ? undefined : prev.slice(0, GBA_APU_CHANNELS),
        )
        .map((write) => ({ ...write, chip: 0 }));

      let keyOn = 0;
      for (let index = 0; index < pcmChannels.length; index += 1) {
        const channel = pcmChannels[index]!;
        const frame = next[GBA_APU_CHANNELS + index]!;
        const before = prev?.[GBA_APU_CHANNELS + index];
        const base = index * VOICE_STRIDE;

        if (!frame.on) {
          // Silence is a level of zero rather than a key-off: it takes effect on
          // the sample, needs no shared register, and leaves the voice ready.
          if (before?.on !== false) {
            writes.push({ reg: base + REG_VOLL, value: 0, chip: 1 });
            writes.push({ reg: base + REG_VOLR, value: 0, chip: 1 });
          }
          continue;
        }

        const retrigger = !before?.on || frame.retrigger === true;
        const waveform = waveformFor(channel.kind, frame.duty);
        if (retrigger || waveformFor(channel.kind, before?.duty) !== waveform) {
          writes.push({ reg: base + REG_SRCN, value: sampleNumber(waveform), chip: 1 });
        }

        // A noise voice plays a recording of a shift register rather than a
        // cycle, so its step is the rate the recording was made at — one — and
        // its pitch is not a thing the arrangement can ask for.
        const step =
          channel.kind === "noise"
            ? 0x10000
            : stepFor(snapPitch(channel.pitch!, frame.hz).hz, WAVE_SAMPLES);
        const beforeStep =
          before?.on && channel.kind !== "noise"
            ? stepFor(snapPitch(channel.pitch!, before.hz).hz, WAVE_SAMPLES)
            : -1;
        if (retrigger || beforeStep !== step) {
          writes.push({ reg: base + REG_STEP0, value: step & 0xff, chip: 1 });
          writes.push({ reg: base + REG_STEP0 + 1, value: (step >> 8) & 0xff, chip: 1 });
          writes.push({ reg: base + REG_STEP0 + 2, value: (step >> 16) & 0xff, chip: 1 });
        }

        // A mixer voice carries a whole byte of level a side, so this half of
        // the console places a part where the arranger asked rather than
        // quantising it — the Game Boy half above is the one with `NR51`.
        const gains = panGains(frame.pan);
        const wasGains = panGains(before?.pan);
        const left = levelByte(frame.level, gains.left);
        const right = levelByte(frame.level, gains.right);
        const beforeLeft = before?.on ? levelByte(before.level, wasGains.left) : -1;
        const beforeRight = before?.on ? levelByte(before.level, wasGains.right) : -1;
        if (retrigger || beforeLeft !== left) {
          writes.push({ reg: base + REG_VOLL, value: left, chip: 1 });
        }
        if (retrigger || beforeRight !== right) {
          writes.push({ reg: base + REG_VOLR, value: right, chip: 1 });
        }
        if (retrigger) keyOn |= 1 << index;
      }

      // One `KON` for the whole tick, last, so every voice it starts has already
      // been told what to play. A pulse register, so it is never written when
      // nothing starts.
      if (keyOn !== 0) writes.push({ reg: GBA_PCM_KON, value: keyOn, chip: 1 });
      return writes;
    },

    fitRate(desiredHz): DriverRateFit {
      // Two of the four timers clock the converters, so a driver has one of its
      // own — sixteen bits of reload against a four-way prescaler, which is the
      // finest clock in the set by a wide margin.
      let best: DriverRateFit | undefined;
      let bestError = Infinity;
      for (const [index, prescale] of PRESCALERS.entries()) {
        for (let steps = 1; steps <= 0x10000; steps += 1) {
          const den = prescale * steps;
          const hz = GBA_CLOCK / den;
          if (hz < 16 || hz > 4096) continue;
          const error = Math.abs(hz - desiredHz);
          if (error < bestError - 1e-12) {
            bestError = error;
            // The register holds the *reload*, which is what the counter starts
            // from and therefore the complement of the count.
            best = {
              rate: { num: GBA_CLOCK, den },
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
 * Which voices a register write belongs to.
 *
 * A plain function of the register for everything except `KON`, whose value *is*
 * a set of voices — and it answers in the *spec's* channel numbering, so the
 * four Game Boy channels come first. No latch anywhere on either chip, so the
 * factory `data.ts` asks for carries no state.
 */
export function gbaChannelTag(): (reg: number, value: number, chip?: number) => number {
  return (reg: number, value: number, chip?: number): number => {
    if (chip !== 1) return gbApuTag(reg);
    if (reg === GBA_PCM_KON) return (value & 0x3f) << GBA_APU_CHANNELS;
    const voice = Math.floor(reg / VOICE_STRIDE);
    return voice < GBA_PCM_VOICES ? 1 << (GBA_APU_CHANNELS + voice) : 0;
  };
}

/** The Game Boy channels a register write touches, in the spec's numbering. */
function gbApuTag(reg: number): number {
  if (reg >= 0x10 && reg <= 0x14) return 0b0001;
  if (reg >= 0x16 && reg <= 0x19) return 0b0010;
  if ((reg >= 0x1a && reg <= 0x1e) || (reg >= 0x30 && reg <= 0x3f)) return 0b0100;
  if (reg >= 0x20 && reg <= 0x23) return 0b1000;
  // `NR50`/`NR51`/`NR52` are everyone's.
  return 0b1111;
}
