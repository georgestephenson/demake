/**
 * The WonderSwan binding.
 *
 * Four wavetable voices, which makes this the PC Engine's encoder with two
 * voices fewer — and then four things that are genuinely this chip's:
 *
 *   - **The pitch register counts the wrong way.** Every other divider in the
 *     set is the number the clock is divided by; this one is *subtracted from
 *     2048* first, so a larger value is a higher note and the register a driver
 *     writes is not the divider the lattice describes. The spec declares the
 *     lattice (`audio-specs.ts` §`wsPitchedChannel`) and this file does the
 *     subtraction, which is the split doc 16 draws between what a musician hears
 *     and how a chip encodes it.
 *   - **The waveforms are memory, so `init()` is short and a page goes in the
 *     cartridge.** The PC Engine uploads thirty-two register writes a channel;
 *     here the whole table is sixty-four bytes the driver copies into RAM and
 *     one write of `$8F` to say where (`wsc-bank.ts`). So this console's boot is
 *     the shortest of any wavetable machine in the set, and its bank is the only
 *     one that is bytes rather than either writes or samples.
 *   - **The shared register is an enable mask.** `$90` carries all four channel
 *     enables and the three mode bits in one byte, so it is exactly the NES's
 *     `$4015` problem: two streams both write it, so the driver merges rather
 *     than stores, and clearing a channel's bit is also how that channel is
 *     silenced. Panning is the channel's own byte and needs no merge at all.
 *   - **Noise is a tap, not a rate.** The shift register is fifteen bits and the
 *     mode picks how far along it is tapped, so a percussion index chooses a
 *     *sequence length* while the pitch stays the channel's own divider — which
 *     means this console's kit has both a colour and a pitch where a Game Boy's
 *     has only the one.
 *
 * The clock is the frame, at 75.47 Hz. This machine has two timers that could
 * raise an interrupt, and a demade cartridge takes neither: its interrupt
 * controller vectors through the processor's own table in the first kilobyte of
 * RAM, and a main loop that already waits for the beam gains nothing by it. What
 * the hardware gives instead is a vertical-blank timer whose **counter is
 * readable**, so a driver counts frames rather than riding them without a
 * handler anywhere (doc 16 §A frame-clocked console counts frames).
 *
 * Source: WSdev wiki — Sound (https://ws.nesdev.org/wiki/Sound).
 */

import { math, type AudioSpec } from "@demake/core";
import { WS_NOISE_CHANNEL, WS_SOUND_CHANNELS, WS_SOUND_REG } from "@demake/chip";

import type { ChannelFrame } from "../chipscript.js";
import { snapPitch, snapVolume } from "../pitch.js";

import { wsWaveformFor, WS_WAVE_BASE, type WsWaveform } from "./wsc-bank.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

/** Noise tap modes the register offers, longest sequence first. */
const NOISE_MODES = 8;

/** The divider a drum sits on at the ends of the shared percussion scale. */
const NOISE_DIVIDER_LOW = 2048;
const NOISE_DIVIDER_HIGH = 64;

/**
 * A noise index on the shared 0–63 percussion scale, as this chip's tap mode.
 *
 * The drum map and the gesture sweeps both work in that range
 * (`arrange/compile.ts` §`DRUM_MAP`, `sfx/index.ts`), low-pitched to high, and
 * this register offers eight modes — but they are *lengths* rather than rates,
 * and the hardware's own order runs longest first: mode 0 is a 32767-step
 * sequence that sounds like hiss and mode 7 is 28 steps that sound like a rasp.
 * A low index therefore wants a high mode, which is why this reverses.
 */
function noiseTap(index: number): number {
  const clamped = Math.round(index) < 0 ? 0 : Math.round(index);
  const scaled = Math.round((clamped * (NOISE_MODES - 1)) / 63);
  return NOISE_MODES - 1 - (scaled > NOISE_MODES - 1 ? NOISE_MODES - 1 : scaled);
}

/**
 * The same index as this chip's noise *pitch*, which is the channel's divider.
 *
 * This console's kit has both a colour and a pitch where a Game Boy's has only
 * a period: the shift register is clocked by channel four's own divider, so a
 * drum index picks a tap (how long the sequence is) *and* a rate (how fast it
 * runs). Spending both is what makes a closed hat, an open hat and a tom
 * distinguishable on eight modes.
 *
 * Geometric rather than linear, because pitch is: the octave between two indices
 * is the same wherever on the scale they sit, which is the property the drum map
 * is written against. It uses `core`'s kernels rather than `Math.pow` — this
 * package runs under the determinism rule (doc 16 §Determinism engineering).
 */
function noiseDivider(index: number): number {
  const clamped = index < 0 ? 0 : index > 63 ? 63 : Math.round(index);
  const ratio = math.pow(NOISE_DIVIDER_HIGH / NOISE_DIVIDER_LOW, clamped / 63);
  const divider = Math.round(NOISE_DIVIDER_LOW * ratio);
  return divider < 1 ? 1 : divider > NOISE_DIVIDER_LOW ? NOISE_DIVIDER_LOW : divider;
}

/**
 * The eleven-bit register a frame asks a pitched channel for.
 *
 * The lattice's divider is `2048 - register`, so this is the inverse — and a
 * divider of 2048 (the floor) is register zero, which is why the clamp is here
 * rather than a mask.
 */
function registerFor(channel: AudioSpec["channels"][number], hz: number): number {
  const divider = snapPitch(channel.pitch!, hz).divider;
  const value = 2048 - divider;
  return value < 0 ? 0 : value > 0x7ff ? 0x7ff : value;
}

/** The volume byte a frame asks for: four bits a side, fifteen is full. */
function volumeFor(channel: AudioSpec["channels"][number], frame: ChannelFrame): number {
  const level = snapVolume(channel.volume, frame.level);
  const left = frame.pan?.left ?? true;
  const right = frame.pan?.right ?? true;
  return ((left ? level : 0) << 4) | (right ? level : 0);
}

/** Which waveform each channel is given, in spec order. */
export function wsWaveforms(spec: AudioSpec): WsWaveform[] {
  const seen = new Map<string, number>();
  return spec.channels.map((channel) => {
    const ordinal = seen.get(channel.kind) ?? 0;
    seen.set(channel.kind, ordinal + 1);
    return wsWaveformFor(channel.kind, ordinal);
  });
}

export function wscBinding(console: string, spec: AudioSpec): ChipBinding {
  if (spec.channels.length > WS_SOUND_CHANNELS) {
    throw new Error(
      `this chip has ${WS_SOUND_CHANNELS} channels and the spec declares ${spec.channels.length}`,
    );
  }
  const noiseIndex = spec.channels.findIndex((channel) => channel.kind === "noise");
  if (noiseIndex >= 0 && noiseIndex !== WS_NOISE_CHANNEL) {
    // One shift register, wired to channel four: a spec that put the kit
    // anywhere else would arrange a part onto hardware that cannot play it.
    throw new Error(
      `this chip's noise generator is channel ${WS_NOISE_CHANNEL + 1}; the spec puts it on channel ${noiseIndex + 1}`,
    );
  }

  return {
    console,
    chips: spec.chips,
    spec,

    init(): BoundWrite[] {
      // The output stage and the wave base, which are the only two registers
      // that belong to the chip rather than to a channel.
      const writes: BoundWrite[] = [
        // Headphones and speaker both on, speaker at full: a demade cartridge
        // has no volume control, so this is stated once and never again.
        { reg: WS_SOUND_REG.OUTPUT, value: 0x11 },
        // Where the four waveforms are. The *bytes* are somebody else's — the
        // renderer places them behind the model and a cartridge's driver copies
        // them into RAM — but the address is one constant both of them read
        // (`wsc-bank.ts`), which is what stops the two disagreeing.
        { reg: WS_SOUND_REG.WAVE_BASE, value: (WS_WAVE_BASE >> 6) & 0xff },
        { reg: WS_SOUND_REG.SWEEP_STEP, value: 0x00 },
        { reg: WS_SOUND_REG.SWEEP_TIME, value: 0x00 },
        { reg: WS_SOUND_REG.NOISE, value: 0x00 },
        { reg: WS_SOUND_REG.CONTROL, value: 0x00 },
      ];
      for (let index = 0; index < spec.channels.length; index += 1) {
        writes.push({ reg: WS_SOUND_REG.CH1_VOLUME + index, value: 0x00 });
        writes.push({ reg: WS_SOUND_REG.CH1_FREQ_LOW + index * 2, value: 0x00 });
        writes.push({ reg: WS_SOUND_REG.CH1_FREQ_HIGH + index * 2, value: 0x00 });
      }
      return writes;
    },

    encode(next, prev): BoundWrite[] {
      const out: BoundWrite[] = [];
      // The enable mask is rebuilt from what every channel is doing, because it
      // is one byte for all four — so it is emitted once, last, and only when it
      // moved. That is `$4015`'s shape, and it is what the driver merges.
      let enables = 0;
      let noiseSelected = false;
      let previousEnables = 0;
      let previousNoise = false;

      for (let index = 0; index < spec.channels.length; index += 1) {
        const channel = spec.channels[index]!;
        const frame = next[index]!;
        const before = prev?.[index];
        if (frame.on) enables |= 1 << index;
        if (before?.on) previousEnables |= 1 << index;
        if (index === WS_NOISE_CHANNEL) {
          noiseSelected = frame.on && channel.kind === "noise";
          previousNoise = (before?.on ?? false) && channel.kind === "noise";
        }

        if (!frame.on) {
          // Silence is the volume byte as well as the enable bit. Both, because
          // the enable is shared and a driver that only cleared it would leave a
          // channel a preempting effect handed back sounding at the effect's
          // level (doc 16 §Give a borrowed channel back).
          if (before?.on !== false) out.push({ reg: volumeReg(index), value: 0x00 });
          continue;
        }

        const retrigger = !before?.on || frame.retrigger === true;
        const volume = volumeFor(channel, frame);

        if (channel.kind === "noise") {
          const tap = noiseTap(frame.noisePeriod ?? 20);
          const beforeTap = before?.on ? noiseTap(before.noisePeriod ?? 20) : -1;
          // A retrigger resets the shift register, which is what makes two hits
          // of the same drum sound the same rather than continuing one rattle.
          if (retrigger || beforeTap !== tap) {
            out.push({ reg: WS_SOUND_REG.NOISE, value: 0x80 | 0x40 | tap });
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
          out.push({ reg: freqLowReg(index), value: register & 0xff });
          out.push({ reg: freqHighReg(index), value: (register >> 8) & 0x07 });
        }

        if (retrigger || volumeFor(channel, before!) !== volume) {
          out.push({ reg: volumeReg(index), value: volume });
        }
      }

      const control = enables | (noiseSelected ? 0x80 : 0x00);
      const previous = previousEnables | (previousNoise ? 0x80 : 0x00);
      if (prev === undefined || control !== previous) {
        out.push({ reg: WS_SOUND_REG.CONTROL, value: control });
      }
      return out;
    },

    fitRate(): DriverRateFit {
      // The frame and only the frame, so a schedule's rate is the console's
      // whether it asked for it or not — the NES's and the Sega 8-bits' answer,
      // at a rate that is neither sixty nor a multiple of it.
      return { rate: spec.driver.frameRate, source: "vblank" };
    },
  };
}

function volumeReg(channel: number): number {
  return WS_SOUND_REG.CH1_VOLUME + channel;
}
function freqLowReg(channel: number): number {
  return WS_SOUND_REG.CH1_FREQ_LOW + channel * 2;
}
function freqHighReg(channel: number): number {
  return WS_SOUND_REG.CH1_FREQ_HIGH + channel * 2;
}

/**
 * Which channel a register write belongs to.
 *
 * Every register here is addressed by number rather than through a select, so
 * unlike the PC Engine's this needs no latch and is not a factory over hidden
 * state — the frequency pair and the volume byte name their channel in the
 * address, and the noise register belongs to channel four alone.
 *
 * `$90` belongs to *all* of them, and `$91` to none: the control byte is what
 * two streams share and the driver merges, so it is tagged with every channel so
 * a preempting effect's copy of it is never skipped.
 */
export function wscChannelTag(): (reg: number, value: number, chip?: number) => number {
  return (reg: number): number => {
    if (reg >= WS_SOUND_REG.CH1_FREQ_LOW && reg <= WS_SOUND_REG.CH4_FREQ_HIGH) {
      return 1 << ((reg - WS_SOUND_REG.CH1_FREQ_LOW) >> 1);
    }
    if (reg >= WS_SOUND_REG.CH1_VOLUME && reg <= WS_SOUND_REG.CH4_VOLUME) {
      return 1 << (reg - WS_SOUND_REG.CH1_VOLUME);
    }
    if (reg === WS_SOUND_REG.NOISE) return 1 << WS_NOISE_CHANNEL;
    if (reg === WS_SOUND_REG.CONTROL) return (1 << WS_SOUND_CHANNELS) - 1;
    return 0;
  };
}

/** The register two streams share, which the driver merges and never stores. */
export const WSC_SHARED_REG = WS_SOUND_REG.CONTROL;
