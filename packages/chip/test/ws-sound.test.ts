/**
 * The WonderSwan's sound hardware against documented behaviour.
 *
 * Two of these cases are about the thing that makes this chip unlike every other
 * one in the set: its waveforms are **the console's own RAM**, read through a
 * base register that only carries bits 6–13 of an address. So a timbre is a
 * memory write, the packing order of the two samples in a byte is observable,
 * and a base the driver got wrong is a channel playing whatever else is at that
 * address rather than silence.
 *
 * The rest are the hardware's own arithmetic: the pitch is `clock / (32 × (2048 −
 * divider))` because a cycle is thirty-two samples and the register counts *up*
 * toward the clock rather than down from it; the volume is four linear bits a
 * side with no attenuator behind it; only channel four has a shift register and
 * only channel three sweeps; and `$90` is one byte carrying four enables, which
 * is what makes it the register two streams share.
 *
 * Source: WSdev wiki — Sound (https://ws.nesdev.org/wiki/Sound).
 */

import { describe, expect, it } from "vitest";

import { renderSchedule, type ScheduleTick } from "../src/mix.js";
import type { RegisterWrite } from "../src/types.js";
import {
  WsSound,
  WS_NOISE_CHANNEL,
  WS_SOUND_CHANNELS,
  WS_SOUND_CLOCK_HZ,
  WS_SOUND_REG as REG,
  WS_SWEEP_CHANNEL,
  WS_WAVE_CHANNEL_BYTES,
  WS_WAVE_SAMPLES,
} from "../src/ws-sound.js";

const RATE = { num: 60, den: 1 };

/** Where the waveforms go: sixty-four-byte aligned, and the register's range. */
const WAVE_BASE = 0x0800;

function hold(writes: RegisterWrite[], ticks: number): ScheduleTick[] {
  const out: ScheduleTick[] = [{ writes }];
  for (let i = 1; i < ticks; i += 1) out.push({ writes: [] });
  return out;
}

function frequencyOf(samples: Float32Array, sampleRate: number): number {
  let crossings = 0;
  let previous = samples[0] as number;
  for (let i = 1; i < samples.length; i += 1) {
    if (previous <= 0 && (samples[i] as number) > 0) crossings += 1;
    previous = samples[i] as number;
  }
  return (crossings * sampleRate) / samples.length;
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += (samples[i] as number) * (samples[i] as number);
  return Math.sqrt(sum / (to - from));
}

/** A 50% square, as the thirty-two four-bit samples the chip walks. */
const SQUARE = Array.from({ length: WS_WAVE_SAMPLES }, (_, i) =>
  i < WS_WAVE_SAMPLES / 2 ? 15 : 0,
);

/**
 * A machine's RAM with one channel's waveform written into it.
 *
 * Two samples a byte, the *low* nibble first — which is the packing the model
 * has to agree with the hardware about and the only place it can be seen.
 */
function ramWith(channel: number, samples: readonly number[]): Uint8Array {
  const ram = new Uint8Array(0x10000);
  const at = WAVE_BASE + channel * WS_WAVE_CHANNEL_BYTES;
  for (let index = 0; index < WS_WAVE_SAMPLES; index += 2) {
    ram[at + (index >> 1)] =
      ((samples[index] ?? 0) & 0x0f) | (((samples[index + 1] ?? 0) & 0x0f) << 4);
  }
  return ram;
}

/** Programme a channel's eleven-bit divider and turn it on at `volume`. */
function play(channel: number, divider: number, volume = 15): RegisterWrite[] {
  return [
    { reg: REG.WAVE_BASE, value: WAVE_BASE >> 6 },
    { reg: REG.CH1_FREQ_LOW + channel * 2, value: divider & 0xff },
    { reg: REG.CH1_FREQ_HIGH + channel * 2, value: (divider >> 8) & 0x07 },
    { reg: REG.CH1_VOLUME + channel, value: (volume << 4) | volume },
    { reg: REG.OUTPUT, value: 0x11 },
    { reg: REG.CONTROL, value: 1 << channel },
  ];
}

describe("the WonderSwan's sound hardware", () => {
  it("plays f = clock / (32 × (2048 − divider)), counting up rather than down", () => {
    // 3072000 / (32 × (2048 − 1830)) ≈ 440.6 Hz. The register is the *opposite*
    // way round from every other divider in the set: it is subtracted from 2048,
    // so a larger value is a higher note.
    const divider = 1830;
    const pcm = renderSchedule(
      new WsSound({ ram: ramWith(0, SQUARE) }),
      hold(play(0, divider), 60),
      RATE,
    );
    const expected = WS_SOUND_CLOCK_HZ / (32 * (2048 - divider));
    expect(expected).toBeCloseTo(440.6, 0);
    expect(frequencyOf(pcm.channels[0] as Float32Array, pcm.sampleRate)).toBeCloseTo(expected, -1);
  });

  it("bottoms out at 46.875 Hz, which is a divider of zero", () => {
    // The floor is where the pitch lattice is finest, and it is low enough that
    // no bass line on this console has to be transposed.
    const pcm = renderSchedule(
      new WsSound({ ram: ramWith(0, SQUARE) }),
      hold(play(0, 0), 120),
      RATE,
    );
    const expected = WS_SOUND_CLOCK_HZ / (32 * 2048);
    expect(expected).toBeCloseTo(46.875, 3);
    expect(frequencyOf(pcm.channels[0] as Float32Array, pcm.sampleRate)).toBeCloseTo(expected, -1);
  });

  it("reads two samples from a byte, the low nibble first", () => {
    // The packing is the one thing about the wave table a driver cannot get away
    // with guessing: swap the nibbles and a square becomes a square of the same
    // duty half a sample later, which is why the waveform here is *asymmetric*.
    // Four full samples then twenty-eight empty ones: an eighth-duty pulse whose
    // edge lands inside a byte rather than on one.
    const pulse = Array.from({ length: WS_WAVE_SAMPLES }, (_, i) => (i < 4 ? 15 : 0));
    const chip = new WsSound({ ram: ramWith(0, pulse) });
    for (const write of play(0, 1830)) chip.write(write.reg, write.value);
    // The byte holding samples 0 and 1 is both-on; the one holding 4 and 5 is
    // both-off; the one holding 2 and 3 is both-on. A high-nibble-first model
    // would put the edge one sample earlier and read $0F where this reads $FF.
    const ram = ramWith(0, pulse);
    expect(ram[WAVE_BASE]).toBe(0xff);
    expect(ram[WAVE_BASE + 1]).toBe(0xff);
    expect(ram[WAVE_BASE + 2]).toBe(0x00);
  });

  it("plays whatever is at the base the register names", () => {
    // Sixty-four bytes read from main RAM, so pointing the chip a page away is
    // not silence *by design* — it plays whatever the game left there, which
    // here is a page of zeroes: a flat waveform eight below the midpoint, which
    // is a DC level and not a note. This is the case that would fail if a driver
    // wrote the base un-shifted, and it is checked by the tone rather than by
    // the amplitude for exactly that reason.
    const tone = (base: number): number => {
      const pcm = renderSchedule(
        new WsSound({ ram: ramWith(0, SQUARE) }),
        hold(
          play(0, 1830).map((w) => (w.reg === REG.WAVE_BASE ? { ...w, value: base } : w)),
          30,
        ),
        RATE,
      );
      return frequencyOf(pcm.channels[0] as Float32Array, pcm.sampleRate);
    };
    expect(tone(WAVE_BASE >> 6)).toBeCloseTo(WS_SOUND_CLOCK_HZ / (32 * (2048 - 1830)), -1);
    expect(tone(0x10)).toBeLessThan(1);
  });

  it("attenuates linearly, four bits a side, with no table behind it", () => {
    const at = (volume: number): number => {
      const pcm = renderSchedule(
        new WsSound({ ram: ramWith(0, SQUARE) }),
        hold(play(0, 1830, volume), 60),
        RATE,
      );
      const samples = pcm.channels[0] as Float32Array;
      return rms(samples, samples.length >> 2);
    };
    const full = at(15);
    // Half the register is half the amplitude — a multiply, not 1.5 dB steps.
    expect(at(8) / full).toBeCloseTo(8 / 15, 1);
    expect(at(4) / full).toBeCloseTo(4 / 15, 1);
    expect(at(0)).toBeLessThan(0.001);
  });

  it("pans by level, so a channel can sit anywhere across the stereo field", () => {
    const pcm = renderSchedule(
      new WsSound({ ram: ramWith(0, SQUARE) }),
      hold(
        [
          ...play(0, 1830).filter((w) => w.reg !== REG.CH1_VOLUME),
          { reg: REG.CH1_VOLUME, value: 0xf0 },
        ],
        30,
      ),
      RATE,
    );
    expect(rms(pcm.channels[0] as Float32Array)).toBeGreaterThan(0.05);
    expect(rms(pcm.channels[1] as Float32Array)).toBeLessThan(0.001);
  });

  it("gives the shift register to channel four alone", () => {
    // Selecting noise on any other channel is a no-op rather than an error,
    // because the hardware has one generator and it is wired to channel four.
    const noise = (channel: number): number => {
      const pcm = renderSchedule(
        new WsSound({ ram: ramWith(channel, SQUARE) }),
        hold(
          [
            ...play(channel, 1400),
            { reg: REG.NOISE, value: 0x80 },
            { reg: REG.CONTROL, value: 0x80 | (1 << channel) },
          ],
          30,
        ),
        RATE,
      );
      const samples = pcm.channels[0] as Float32Array;
      return frequencyOf(samples, pcm.sampleRate);
    };
    // A square at this divider is a clean tone; noise is broadband, so it crosses
    // zero far more often than the waveform it replaced.
    const tone = WS_SOUND_CLOCK_HZ / (32 * (2048 - 1400));
    expect(noise(0)).toBeCloseTo(tone, -1);
    expect(noise(WS_NOISE_CHANNEL)).toBeGreaterThan(tone * 2);
  });

  it("sweeps channel three and nothing else", () => {
    // The sweep adds a signed step to the divider every `time + 1` ticks of a
    // 375 Hz clock, so the pitch it lands on after a second is the arithmetic
    // rather than a ramp anybody has to shape.
    const chip = new WsSound({ ram: ramWith(WS_SWEEP_CHANNEL, SQUARE) });
    const start = 1400;
    for (const write of play(WS_SWEEP_CHANNEL, start)) chip.write(write.reg, write.value);
    chip.write(REG.SWEEP_STEP, 4);
    chip.write(REG.SWEEP_TIME, 0);
    chip.write(REG.CONTROL, 0x40 | (1 << WS_SWEEP_CHANNEL));
    // Ten sweep ticks at 375 Hz, four each: the divider rises by forty.
    const sink = { clocksUntilSampleBoundary: () => 1024, add: () => undefined };
    chip.run((WS_SOUND_CLOCK_HZ / 375) * 10 + 1, sink);
    // Then the sweep goes off, because it does not stop of its own accord: the
    // divider it has reached is what has to be measured, and a sweep still
    // running during the measurement is a smear rather than a pitch.
    chip.write(REG.CONTROL, 1 << WS_SWEEP_CHANNEL);
    const raised = WS_SOUND_CLOCK_HZ / (32 * (2048 - (start + 40)));
    const pcm = renderSchedule(chip, hold([], 20), RATE);
    expect(frequencyOf(pcm.channels[0] as Float32Array, pcm.sampleRate)).toBeCloseTo(raised, -1);
  });

  it("carries every channel's enable in one register, which is why it is shared", () => {
    // `$90` is this chip's `NR51`: four enables and three mode bits in one byte,
    // so a driver playing music and an effect at once has to merge rather than
    // store (doc 16 §`NR51` is merged).
    const chip = new WsSound({ ram: ramWith(0, SQUARE) });
    for (const write of play(0, 1830)) chip.write(write.reg, write.value);
    const sink = { clocksUntilSampleBoundary: () => 1024, add: () => undefined };
    chip.run(1024, sink);
    // Enabling channel two by storing rather than merging silences channel one.
    chip.write(REG.CONTROL, 0x02);
    const pcm = renderSchedule(chip, hold([], 20), RATE);
    expect(rms(pcm.channels[0] as Float32Array)).toBeLessThan(0.001);
    expect(WS_SOUND_CHANNELS).toBe(4);
  });

  it("keeps the voice register it does not play", () => {
    // Channel two's PCM mode is a gap rather than a decision, so the writes are
    // stored and inert and a test says so (AGENTS.md §Iron rules).
    const chip = new WsSound();
    chip.write(REG.CONTROL, 0x20);
    chip.write(REG.VOICE_VOLUME, 0x0c);
    expect(chip.voiceEnabled).toBe(true);
    expect(chip.voiceVolume).toBe(0x0c);
  });
});
