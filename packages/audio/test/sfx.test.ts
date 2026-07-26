/**
 * The sound demaker (doc 18).
 *
 * The fixtures are synthesized rather than recorded, so each one *is* a known
 * class: a rising sweep, a noise burst, a decaying tone. That is what makes the
 * anti-gaming assertions possible — a sweep must be fitted by a sweep and a
 * noise burst must not come back tonal, which is the failure that turns every
 * explosion into a beep.
 */

import { describe, expect, it } from "vitest";

import { math } from "@demake/core";

import { analyzeSound } from "../src/sfx/analyze.js";
import { decodeSound, SoundDecodeError } from "../src/sfx/decode.js";
import { demakeSfx } from "../src/sfx/index.js";
import { encodeWav } from "../src/encode/wav.js";
import { render } from "../src/render.js";
import { inspectScript } from "../src/inspect.js";

const RATE = 48000;

/** Wrap mono float samples as a 16-bit WAV, the way a user's file arrives. */
function wavOf(samples: Float32Array): Uint8Array {
  return encodeWav({ sampleRate: RATE, channels: [samples] });
}

/** A tone whose pitch ramps from `fromHz` to `toHz`, with a decay. */
function sweep(fromHz: number, toHz: number, seconds: number, decay = 1): Float32Array {
  const length = Math.floor(seconds * RATE);
  const out = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const position = i / length;
    const hz = fromHz + (toHz - fromHz) * position;
    phase += (2 * 3.141592653589793 * hz) / RATE;
    out[i] = math.sin(phase) * math.pow(1 - position, decay);
  }
  return out;
}

/** A noise burst with a decaying envelope, from a fixed LFSR — no host RNG. */
function noiseBurst(seconds: number, decay = 3): Float32Array {
  const length = Math.floor(seconds * RATE);
  const out = new Float32Array(length);
  let lfsr = 0x7fff;
  for (let i = 0; i < length; i += 1) {
    const feedback = (lfsr & 1) ^ ((lfsr >> 1) & 1);
    lfsr = (lfsr >> 1) | (feedback << 14);
    const position = i / length;
    out[i] = ((lfsr & 1) === 0 ? 1 : -1) * math.pow(1 - position, decay);
  }
  return out;
}

/** A steady tone with a long decay — a chime. */
function chime(hz: number, seconds: number): Float32Array {
  return sweep(hz, hz * 0.98, seconds, 1.5);
}

describe("sound analysis", () => {
  it("classifies a rising sweep as swept", () => {
    const features = analyzeSound(sweep(300, 1200, 0.4));
    expect(features.soundClass).toBe("swept");
    expect(features.startF0).toBeGreaterThan(200);
    expect(features.endF0).toBeGreaterThan(features.startF0);
  });

  it("classifies a noise burst as percussive, not tonal", () => {
    const features = analyzeSound(noiseBurst(0.2));
    expect(["percussive", "noisy"]).toContain(features.soundClass);
    // The gate that stops an explosion coming back as a beep starts here.
    expect(features.soundClass).not.toBe("tonal");
  });

  it("measures the envelope's shape, not just its level", () => {
    const fast = analyzeSound(sweep(440, 440, 0.4, 6));
    const slow = analyzeSound(sweep(440, 440, 0.4, 0.3));
    const half = (envelope: number[]): number =>
      envelope.findIndex((value) => value < 0.5) / envelope.length;
    expect(half(fast.envelope)).toBeLessThan(half(slow.envelope));
  });
});

describe("decoding", () => {
  it("round-trips a WAV through the decoder", () => {
    const samples = sweep(440, 440, 0.1, 0);
    const decoded = decodeSound(wavOf(samples));
    expect(decoded.source.format).toBe("wav");
    expect(decoded.source.sampleRate).toBe(RATE);
    expect(decoded.samples.length).toBeGreaterThan(0);
  });

  it("says what it cannot read rather than guessing", () => {
    expect(() => decodeSound(new Uint8Array([1, 2, 3, 4]))).toThrow(SoundDecodeError);
    expect(() => decodeSound(new Uint8Array([1, 2, 3, 4]))).toThrow(/only WAV input/);
  });
});

describe("demaking an effect", () => {
  it("produces a compliant one-shot on a single channel", () => {
    const result = demakeSfx(wavOf(sweep(300, 1400, 0.3)), { console: "dmg" });
    expect(inspectScript(result.script).violations).toEqual([]);
    // A one-shot, not a loop: every player honours -1, and a looping effect
    // would never stop.
    expect(result.script.loopTick).toBe(-1);
    expect(result.script.channels).toHaveLength(1);
  });

  it("fits a rising sweep with a rising sweep, and a falling one with a fall", () => {
    // Direction is the whole difference between these two families, so getting
    // it right is the minimum bar. It needs scoring pitch against what the
    // hardware will *play* rather than against a pitch tracker's reading of our
    // own square wave, which makes octave errors on a narrow duty cycle.
    const up = demakeSfx(wavOf(sweep(300, 1400, 0.3)), { console: "dmg" });
    expect(up.soundClass).toBe("swept");
    expect(up.tournament.winner).toBe("sweep-up");

    const down = demakeSfx(wavOf(sweep(1700, 500, 0.3)), { console: "dmg" });
    expect(down.tournament.winner).toBe("sweep-down");
  });

  it("never answers a noise burst with a pure tone", () => {
    // The anti-gaming fixture: a beep is the closest single sine to almost
    // anything, so a scoring function without a class gate picks one here.
    const result = demakeSfx(wavOf(noiseBurst(0.25)), { console: "dmg" });
    expect(result.placement.channelId).toBe("noise");
    expect(result.tournament.winner).not.toBe("blip");
    expect(result.tournament.winner).not.toBe("bell");
  });

  it("keeps a chime on a pitched channel", () => {
    const result = demakeSfx(wavOf(chime(880, 0.5)), { console: "dmg" });
    expect(result.placement.channelId).not.toBe("noise");
  });

  it("honours the length budget and says what it cut", () => {
    const result = demakeSfx(wavOf(sweep(400, 800, 2.0, 0.2)), {
      console: "dmg",
      maxLength: 0.5,
    });
    const seconds =
      (result.script.ticks.length * result.script.driver.rate.den) / result.script.driver.rate.num;
    expect(seconds).toBeLessThan(0.75);
    expect(result.diagnostics.some((entry) => entry.code === "trimmed")).toBe(true);
  });

  it("declares where it wants to sit, so a driver can place it", () => {
    const result = demakeSfx(wavOf(noiseBurst(0.2)), { console: "dmg" });
    expect(result.placement.prefers).toContain(result.placement.channelId);
    expect(result.placement.priority).toBeGreaterThan(0);
  });

  it("makes audible sound", () => {
    const result = demakeSfx(wavOf(sweep(300, 1400, 0.3)), { console: "dmg" });
    const pcm = render(result.script);
    let peak = 0;
    for (const sample of pcm.channels[0]!) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeGreaterThan(0.05);
  });

  it("is deterministic", () => {
    const wav = wavOf(sweep(300, 1400, 0.3));
    const a = demakeSfx(wav, { console: "dmg" });
    const b = demakeSfx(wav, { console: "dmg" });
    expect(a.artifact).toEqual(b.artifact);
    expect(a.tournament.winner).toBe(b.tournament.winner);
  });

  it("works on every console with an audio spec", () => {
    for (const consoleId of ["dmg", "nes", "sms", "gg", "sg1000"]) {
      const result = demakeSfx(wavOf(noiseBurst(0.2)), { console: consoleId });
      expect(inspectScript(result.script).compliant).toBe(true);
    }
  });
});
