/**
 * The PC Engine binding.
 *
 * Six voices and every one of them the same hardware, which makes this the only
 * chip in the set whose *timbre* is a boot decision rather than a note's. What
 * shapes the encoder is the one thing that is genuinely this chip's and nobody
 * else's:
 *
 *   - **The channel is a latch, and it is a register.** An SN76489 carries its
 *     channel in the top bits of the data byte; a Game Boy register belongs to a
 *     channel by its address. Here there is a *window*: register `$00` selects a
 *     channel and the eight registers above it then address it, so every write a
 *     stream makes depends on a write that came before. So the tag `data.ts` asks
 *     for carries a latch ({@link pceChannelTag}) exactly as the SN76489's does,
 *     preemption skips whole runs, and the property that makes that safe — every
 *     run opens with a select — is checked rather than assumed
 *     (`rom/pce-game.ts` §`checkSelectDiscipline`).
 *   - **There is no register two streams share.** The global level is written
 *     once at boot and never again, panning is the channel's own byte, and there
 *     is no key-on pulse and no enable mask — so a game emits no merge routine at
 *     all. A Master System and a Mega Drive are the other two that can say that,
 *     and all three say it by having *less* shared hardware rather than more.
 *   - **Volume is an attenuator and note-off is the enable bit.** Five bits in
 *     1.5 dB steps in the same byte as the enable, so a whole dynamic shape is
 *     one write a tick and silence is that byte cleared — which also resets the
 *     channel's wave pointer, so the next note starts at phase zero rather than
 *     wherever the last one stopped.
 *   - **A waveform is uploaded, not selected.** Thirty-two writes through the
 *     port, per channel, at boot — see `pce-bank.ts`, which is why there is no
 *     bank in ROM at all.
 *
 * The clock is the CPU's own timer: a seven-bit reload at master ÷ 3 ÷ 1024, so
 * 54.6 Hz to 6991 Hz and 120 Hz within half a hertz. `fitRate` enumerates all
 * hundred and twenty-eight of them.
 *
 * Sources:
 * - Archaic Pixels — PSG: https://archaicpixels.com/PSG
 * - Charles MacDonald — PC Engine hardware notes (`pcetech.txt`), §PSG
 */

import type { AudioSpec } from "@demake/core";
import { HUC6280_FIRST_NOISE_CHANNEL, HUC6280_PSG_CHANNELS, HUC6280_PSG_REG } from "@demake/chip";

import type { ChannelFrame } from "../chipscript.js";
import { snapPitch, snapVolume } from "../pitch.js";

import { pceWaveform, pceWaveformFor, PCE_WAVE_SAMPLES } from "./pce-bank.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

/** The CPU's clock, which is the master clock divided by three. */
const CPU_CLOCK_NUM = 21477270;
const CPU_CLOCK_DEN = 3;

/** What the timer divides that by before its own seven-bit reload counts. */
const TIMER_PRESCALE = 1024;

/** Reload values the timer register holds: seven bits, and every one is usable. */
const TIMER_RELOADS = 128;

/**
 * A noise index on the shared 0–63 percussion scale, as this chip's five-bit
 * rate.
 *
 * The drum map and the gesture sweeps both work in that range (`arrange/compile.ts`
 * §`DRUM_MAP`, `sfx/index.ts`), low-pitched to high, and this chip offers
 * thirty-two rates — so the mapping is a halving rather than a clamp. Clamping
 * would put a closed hat, an open hat and a cymbal on the same rate, which is
 * three drums that stop being distinguishable.
 */
function noiseRate(index: number): number {
  const clamped = Math.round(index) < 0 ? 0 : Math.round(index);
  const scaled = Math.round((clamped * 31) / 63);
  return scaled > 31 ? 31 : scaled;
}

/** The twelve-bit divider a frame asks a pitched channel for. */
function dividerFor(channel: AudioSpec["channels"][number], hz: number): number {
  // 4096 and 0 are the same setting on this chip, which is what the mask does.
  return snapPitch(channel.pitch!, hz).divider & 0xfff;
}

/** The balance byte a frame's panning asks for: four bits a side, 15 is full. */
function balanceFor(frame: ChannelFrame): number {
  const left = frame.pan?.left ?? true;
  const right = frame.pan?.right ?? true;
  if (left === right) return 0xff;
  return left ? 0xf0 : 0x0f;
}

export function pceBinding(console: string, spec: AudioSpec): ChipBinding {
  if (spec.channels.length > HUC6280_PSG_CHANNELS) {
    throw new Error(
      `this chip has ${HUC6280_PSG_CHANNELS} channels and the spec declares ${spec.channels.length}`,
    );
  }
  const noiseIndex = spec.channels.findIndex((channel) => channel.kind === "noise");
  if (noiseIndex >= 0 && noiseIndex < HUC6280_FIRST_NOISE_CHANNEL) {
    // Only the last two channels have a shift register, so a spec that put the
    // kit anywhere else would arrange a part onto hardware that cannot play it.
    throw new Error(
      `this chip's noise generator is on channels ${HUC6280_FIRST_NOISE_CHANNEL + 1} and up; the spec puts it on channel ${noiseIndex + 1}`,
    );
  }

  return {
    console,
    chips: spec.chips,
    spec,

    init(): BoundWrite[] {
      // Both sides at full: this register is the chip's, so it is stated once
      // here and never appears in a stream — which is what leaves this console
      // with no shared register for two streams to fight over.
      const writes: BoundWrite[] = [{ reg: HUC6280_PSG_REG.GLOBAL, value: 0xff }];
      // How many channels of the same kind came before this one, which is what
      // hands the three pulse voices three different duties.
      const seen = new Map<string, number>();
      for (let index = 0; index < spec.channels.length; index += 1) {
        const channel = spec.channels[index]!;
        const ordinal = seen.get(channel.kind) ?? 0;
        seen.set(channel.kind, ordinal + 1);
        writes.push({ reg: HUC6280_PSG_REG.SELECT, value: index });
        // Off, with direct D/A off — which is also what resets the wave pointer,
        // so this write *is* the upload's seek to zero. There is no address
        // register, so a driver that skipped it would write into the middle of a
        // cycle (`@demake/chip` §`Huc6280Psg.write`).
        writes.push({ reg: HUC6280_PSG_REG.CONTROL, value: 0x00 });
        writes.push({ reg: HUC6280_PSG_REG.BALANCE, value: 0xff });
        writes.push({ reg: HUC6280_PSG_REG.FREQ_LOW, value: 0x00 });
        writes.push({ reg: HUC6280_PSG_REG.FREQ_HIGH, value: 0x00 });
        if (channel.kind === "noise") {
          writes.push({ reg: HUC6280_PSG_REG.NOISE, value: 0x00 });
          continue;
        }
        const samples = pceWaveform(pceWaveformFor(channel.kind, ordinal));
        for (let at = 0; at < PCE_WAVE_SAMPLES; at += 1) {
          writes.push({ reg: HUC6280_PSG_REG.WAVE, value: samples[at] as number });
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
        const writes: BoundWrite[] = [];

        if (!frame.on) {
          // One byte, and it is the whole of note-off: the enable bit clears, the
          // attenuator goes with it, and the wave pointer resets so the next note
          // opens at phase zero.
          if (before?.on !== false) writes.push({ reg: HUC6280_PSG_REG.CONTROL, value: 0x00 });
        } else {
          const retrigger = !before?.on || frame.retrigger === true;
          const level = snapVolume(channel.volume, frame.level);
          const balance = balanceFor(frame);

          if (retrigger) writes.push({ reg: HUC6280_PSG_REG.CONTROL, value: 0x00 });

          if (channel.kind === "noise") {
            const rate = noiseRate(frame.noisePeriod ?? 20);
            const beforeRate = before?.on ? noiseRate(before.noisePeriod ?? 20) : -1;
            if (retrigger || beforeRate !== rate) {
              writes.push({ reg: HUC6280_PSG_REG.NOISE, value: 0x80 | rate });
            }
          } else {
            const divider = dividerFor(channel, frame.hz);
            const beforeDivider = before?.on ? dividerFor(channel, before.hz) : -1;
            if (retrigger || beforeDivider !== divider) {
              writes.push({ reg: HUC6280_PSG_REG.FREQ_LOW, value: divider & 0xff });
              writes.push({ reg: HUC6280_PSG_REG.FREQ_HIGH, value: (divider >> 8) & 0x0f });
            }
          }

          if (retrigger || balanceFor(before!) !== balance) {
            writes.push({ reg: HUC6280_PSG_REG.BALANCE, value: balance });
          }
          if (retrigger || snapVolume(channel.volume, before!.level) !== level) {
            writes.push({ reg: HUC6280_PSG_REG.CONTROL, value: 0x80 | level });
          }
        }

        // The select goes on only when there is something to select *for*, and it
        // goes on first — which is both the hardware's requirement and the whole
        // of this chip's preemption discipline.
        if (writes.length > 0) {
          out.push({ reg: HUC6280_PSG_REG.SELECT, value: index }, ...writes);
        }
      }
      return out;
    },

    fitRate(desiredHz): DriverRateFit {
      // The CPU's timer, which nothing else in a demade cartridge uses: it counts
      // down from its reload at master ÷ 3 ÷ 1024 and raises an interrupt when it
      // passes zero, so the period is `reload + 1` steps.
      let best: DriverRateFit | undefined;
      let bestError = Infinity;
      for (let reload = 0; reload < TIMER_RELOADS; reload += 1) {
        const den = CPU_CLOCK_DEN * TIMER_PRESCALE * (reload + 1);
        const hz = CPU_CLOCK_NUM / den;
        // The register reaches 6991 Hz and the spec says so, because that is what
        // the hardware does; what a *driver* can usefully keep is the Game Boy's
        // band, and above it a tick is a larger share of the frame than any
        // schedule has ever asked for. Narrowing here rather than in the spec is
        // the split doc 16 draws: the spec is the machine, `fitRate` is the
        // driver that has to ride it.
        if (hz < 16 || hz > 1024) continue;
        const error = Math.abs(hz - desiredHz);
        if (error < bestError - 1e-12) {
          bestError = error;
          best = { rate: { num: CPU_CLOCK_NUM, den }, source: "timer", divisor: reload };
        }
      }
      if (best) return best;
      return { rate: spec.driver.frameRate, source: "vblank" };
    },
  };
}

/**
 * Which channel a register write belongs to, with the chip's select latch in it.
 *
 * Fresh per schedule, because the latch is hardware state that runs *through* a
 * stream: a frequency byte means nothing without the select that came before it.
 * `data.ts` asks for a factory for exactly this reason.
 *
 * The global level and the LFO's two registers belong to no channel and tag zero,
 * which the driver reads as "never skip this". The select itself tags the channel
 * it is selecting, so it groups with the writes that follow it into one run — and
 * a skipped run therefore takes its own selection with it.
 */
export function pceChannelTag(): (reg: number, value: number, chip?: number) => number {
  let latched = 0;
  return (reg: number, value: number): number => {
    if (reg === HUC6280_PSG_REG.SELECT) {
      latched = value & 0x07;
      return latched < HUC6280_PSG_CHANNELS ? 1 << latched : 0;
    }
    if (
      reg === HUC6280_PSG_REG.GLOBAL ||
      reg === HUC6280_PSG_REG.LFO_FREQ ||
      reg === HUC6280_PSG_REG.LFO_CONTROL
    ) {
      return 0;
    }
    return latched < HUC6280_PSG_CHANNELS ? 1 << latched : 0;
  };
}

/**
 * The tag the *packed data* carries: the channels an effect may take, and
 * nothing else.
 *
 * Six channels against a four-bit field, and they do not have to fit — the Mega
 * Drive's answer to the same arithmetic, and for the same reason. What preemption
 * asks is whether an effect may be using a channel, so only the channels effects
 * were placed on are numbered and everything else tags zero, which the driver
 * reads as "never skip this". Four voices of a track therefore play *through* a
 * sound effect instead of ducking for it.
 *
 * The latch rides underneath, because the full tag it wraps is the one that
 * carries it: a select this returns zero for still moves the selection, which is
 * the thing that would otherwise go wrong here and nowhere else.
 */
export function pcePackTag(
  stealable: readonly number[],
): () => (reg: number, value: number, chip: number) => number {
  return () => {
    const full = pceChannelTag();
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

/** The control-register value that silences a selected channel. */
export const PCE_CHANNEL_OFF = 0x00;
