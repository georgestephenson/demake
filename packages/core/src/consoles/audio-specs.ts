/**
 * Per-console `AudioSpec` values (doc 16 §The chips).
 *
 * They live beside the console specs rather than inside each one so that a
 * console file stays a video description and a reader looking for "what can this
 * machine's sound hardware do" finds every answer in one place — the audio
 * counterpart of doc 03's matrix.
 *
 * Numbers here are derived from the primary sources each spec cites, and are
 * ultimately locked by `packages/chip`'s analytic tests rather than by this file:
 * the pitch lattices below and the chip models are two statements of the same
 * hardware, and a test compares them.
 */

import type { AudioSpec } from "./audio.js";

const GB_CLOCK = 4194304;
const NES_CLOCK = 1789773;
const PSG_CLOCK = 3579545;

const GB_SOURCES = [
  "Pan Docs — Audio: https://gbdev.io/pandocs/Audio.html",
  "Pan Docs — Audio Registers: https://gbdev.io/pandocs/Audio_Registers.html",
];

const NES_SOURCES = [
  "nesdev wiki — APU: https://www.nesdev.org/wiki/APU",
  "nesdev wiki — APU Mixer: https://www.nesdev.org/wiki/APU_Mixer",
];

const PSG_SOURCES = [
  "SMS Power — SN76489: https://www.smspower.org/Development/SN76489",
  "SMS Power — Game Gear audio port: https://www.smspower.org/Development/AudioPort",
];

/**
 * The Game Boy APU.
 *
 * Four voices, of which one is noise-only and one is a wavetable — so the wave
 * channel is the swing vote between a distinctive lead and a real bass, which is
 * a candidate axis in doc 17 rather than a fixed choice. Hardware envelopes only
 * decay, so swells cost driver writes.
 */
export const gbAudio: AudioSpec = {
  chips: ["gb-apu"],
  channels: [
    {
      id: "pulse1",
      kind: "pulse",
      chip: 0,
      // f = 131072 / (2048 − x): the divider is 1…2048 and the register holds
      // its complement, which is why the lattice coarsens as pitch rises.
      pitch: { clockHz: GB_CLOCK, step: 32, minDivider: 1, maxDivider: 2048 },
      volume: { steps: 16, law: "linear" },
      duties: [0.125, 0.25, 0.5, 0.75],
      envelope: { kind: "decay", ratePerSecond: 64 },
      panning: "lr-enable",
    },
    {
      id: "pulse2",
      kind: "pulse",
      chip: 0,
      pitch: { clockHz: GB_CLOCK, step: 32, minDivider: 1, maxDivider: 2048 },
      volume: { steps: 16, law: "linear" },
      duties: [0.125, 0.25, 0.5, 0.75],
      envelope: { kind: "decay", ratePerSecond: 64 },
      panning: "lr-enable",
    },
    {
      id: "wave",
      kind: "wave",
      chip: 0,
      // f = 65536 / (2048 − x) — an octave below a pulse at the same divider,
      // which is what makes it the natural bass voice.
      pitch: { clockHz: GB_CLOCK, step: 64, minDivider: 1, maxDivider: 2048 },
      volume: { steps: 4, law: "linear" },
      waveform: { samples: 32, bits: 4 },
      envelope: { kind: "none" },
      panning: "lr-enable",
    },
    {
      id: "noise",
      kind: "noise",
      chip: 0,
      volume: { steps: 16, law: "linear" },
      noise: { periods: 64, tonalMode: true },
      envelope: { kind: "decay", ratePerSecond: 64 },
      panning: "lr-enable",
    },
  ],
  driver: {
    sources: ["timer", "vblank"],
    frameRate: { num: 4194304, den: 70224 },
    timerRange: [16, 4096],
    writesPerTick: 48,
  },
  budgets: { romBytes: 16384 },
  mixing: { channels: 2, linear: true },
  docs: { sources: GB_SOURCES },
};

/**
 * The NES 2A03.
 *
 * The triangle has no volume register at all, so it is a bass voice that cannot
 * be shaped; dynamics have to come from the pulses. Pulse periods below 8 are
 * muted by hardware, which is why the lattice's floor is 54 Hz and not lower.
 */
export const nesAudio: AudioSpec = {
  chips: ["nes-apu"],
  channels: [
    {
      id: "pulse1",
      kind: "pulse",
      chip: 0,
      pitch: { clockHz: NES_CLOCK, step: 16, minDivider: 8, maxDivider: 2048 },
      volume: { steps: 16, law: "linear" },
      duties: [0.125, 0.25, 0.5, 0.75],
      envelope: { kind: "decay", ratePerSecond: 240 },
      panning: "none",
    },
    {
      id: "pulse2",
      kind: "pulse",
      chip: 0,
      pitch: { clockHz: NES_CLOCK, step: 16, minDivider: 8, maxDivider: 2048 },
      volume: { steps: 16, law: "linear" },
      duties: [0.125, 0.25, 0.5, 0.75],
      envelope: { kind: "decay", ratePerSecond: 240 },
      panning: "none",
    },
    {
      id: "triangle",
      kind: "triangle",
      chip: 0,
      pitch: { clockHz: NES_CLOCK, step: 32, minDivider: 2, maxDivider: 2048 },
      // No volume control whatsoever: the channel is on or it is off.
      volume: { steps: 1, law: "linear" },
      envelope: { kind: "none" },
      panning: "none",
    },
    {
      id: "noise",
      kind: "noise",
      chip: 0,
      volume: { steps: 16, law: "linear" },
      noise: { periods: 16, tonalMode: true },
      envelope: { kind: "decay", ratePerSecond: 240 },
      panning: "none",
    },
  ],
  driver: {
    sources: ["timer", "vblank"],
    frameRate: { num: 39375000, den: 655171 },
    timerRange: [60, 240],
    writesPerTick: 40,
  },
  budgets: { romBytes: 16384 },
  mixing: { channels: 1, linear: false },
  docs: { sources: NES_SOURCES },
};

/**
 * 4-bit attenuation in 2 dB steps and **no envelope generator at all**.
 *
 * Every volume shape on this chip is the driver writing a register, so
 * expression has a direct data and CPU cost — the reason doc 17 makes it a
 * candidate axis rather than a default.
 */
const PSG_VOLUME = { steps: 16, law: "db" as const, stepDb: 2 };

/** Build an SN76489 spec; the Game Gear differs only in having stereo. */
function psgAudio(options: {
  stereo: boolean;
  frameRate: { num: number; den: number };
}): AudioSpec {
  const pitch = { clockHz: PSG_CLOCK, step: 32, minDivider: 1, maxDivider: 1023 };
  const panning = options.stereo ? ("lr-enable" as const) : ("none" as const);
  return {
    chips: ["sn76489"],
    channels: [
      { id: "tone1", kind: "pulse", chip: 0, pitch, volume: PSG_VOLUME, panning },
      { id: "tone2", kind: "pulse", chip: 0, pitch, volume: PSG_VOLUME, panning },
      { id: "tone3", kind: "pulse", chip: 0, pitch, volume: PSG_VOLUME, panning },
      {
        id: "noise",
        kind: "noise",
        chip: 0,
        volume: PSG_VOLUME,
        noise: { periods: 4, tonalMode: true },
        panning,
      },
    ],
    driver: {
      sources: ["line-irq", "vblank"],
      frameRate: options.frameRate,
      timerRange: [50, 500],
      writesPerTick: 32,
    },
    budgets: { romBytes: 16384 },
    mixing: { channels: options.stereo ? 2 : 1, linear: true },
    docs: { sources: PSG_SOURCES },
  };
}

/** NTSC Master System / SG-1000: 3579545 / (262 × 228) ≈ 59.92 Hz. */
const SMS_FRAME_RATE = { num: 3579545, den: 59736 };

export const smsAudio: AudioSpec = psgAudio({ stereo: false, frameRate: SMS_FRAME_RATE });
export const ggAudio: AudioSpec = psgAudio({ stereo: true, frameRate: SMS_FRAME_RATE });
export const sg1000Audio: AudioSpec = psgAudio({ stereo: false, frameRate: SMS_FRAME_RATE });

/**
 * The Mega Drive's PSG — the Master System's chip, at the Master System's clock.
 *
 * Not a family resemblance: the same SN76489 sits at `$C00011`, fed by the same
 * master clock divided by fifteen, and an NTSC frame is 262 lines of 3420 master
 * cycles — which is 228 *PSG* cycles a line, so the numbers reduce to exactly
 * {@link SMS_FRAME_RATE}. A schedule fitted for one machine is a schedule the
 * other performs identically, and the only reason this is a separate export is
 * that the day the FM half arrives it stops being true.
 *
 * **The YM2612 is deliberately not named here**, and doc 16 §The chips records
 * what naming it would mean. An `AudioSpec` is the contract the demakers arrange
 * *against* — every channel in it must be one the binding encodes and the chip
 * model plays, and `bindingFor` resolves a console through `chips[0]` — so a chip
 * with no model and no binding in that list would be a promise the arranger
 * cannot keep, on the same terms as doc 14's "a backend gap is a build error,
 * never a silent difference". Six FM voices are what this console's spec gains
 * the day `@demake/chip` can play them.
 */
export const mdAudio: AudioSpec = psgAudio({ stereo: false, frameRate: SMS_FRAME_RATE });
