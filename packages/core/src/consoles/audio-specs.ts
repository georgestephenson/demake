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

import type { AudioChannelSpec, AudioSpec } from "./audio.js";

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

const SNES_SOURCES = [
  "SNESdev Wiki — S-DSP: https://snes.nesdev.org/wiki/S-DSP",
  "SNESdev Wiki — S-SMP (timers and the boot protocol): https://snes.nesdev.org/wiki/S-SMP",
];

/**
 * The S-DSP's pitch lattice, and the first one in the set that counts *up*.
 *
 * A voice plays a waveform at `32000 × PITCH / 4096` samples a second, and the
 * built-in waveforms are one cycle in sixteen samples — so the note is
 * `32000 × PITCH / 65536`, uniform steps of 0.488 Hz all the way up. Every other
 * chip here divides, which crowds its lattice at the bottom and thins it at the
 * top; this one is the reverse, so nothing ever has to be octave-folded to fit
 * and it is the deepest bass that quantises.
 */
const SNES_PITCH = {
  kind: "multiplier" as const,
  clockHz: 32000,
  step: 16 * 4096,
  minDivider: 1,
  maxDivider: 16383,
};

/** Seven bits of level, and it is a *level* rather than an attenuation. */
const SNES_VOLUME = { steps: 128, law: "linear" as const };

/** The exponential-decrease GAIN mode, which is the chip's own decay. */
const SNES_ENVELOPE = { kind: "decay" as const, ratePerSecond: 64 };

/**
 * The Super Nintendo's S-DSP.
 *
 * Eight voices of identical hardware, which is why the kinds below are the
 * *demaker's* assignment rather than the chip's: a voice is a sample player, so
 * what makes it a pulse or a saw is which of the built-in waveforms the driver
 * points it at. Fixing the assignment here is what lets the arranger plan against
 * a stable palette and the driver know its sample bank at build time.
 *
 * Six melodic voices is twice what any other console in the set offers, and it is
 * the one place a demade arrangement is not mostly about what had to go.
 */
export const snesAudio: AudioSpec = {
  chips: ["s-dsp"],
  channels: [
    {
      id: "pulse1",
      kind: "pulse",
      chip: 0,
      pitch: SNES_PITCH,
      volume: SNES_VOLUME,
      duties: [0.125, 0.25, 0.5],
      envelope: SNES_ENVELOPE,
      panning: "lr-level",
    },
    {
      id: "pulse2",
      kind: "pulse",
      chip: 0,
      pitch: SNES_PITCH,
      volume: SNES_VOLUME,
      duties: [0.125, 0.25, 0.5],
      envelope: SNES_ENVELOPE,
      panning: "lr-level",
    },
    {
      id: "pulse3",
      kind: "pulse",
      chip: 0,
      pitch: SNES_PITCH,
      volume: SNES_VOLUME,
      duties: [0.125, 0.25, 0.5],
      envelope: SNES_ENVELOPE,
      panning: "lr-level",
    },
    {
      id: "pulse4",
      kind: "pulse",
      chip: 0,
      pitch: SNES_PITCH,
      volume: SNES_VOLUME,
      duties: [0.125, 0.25, 0.5],
      envelope: SNES_ENVELOPE,
      panning: "lr-level",
    },
    {
      id: "wave1",
      kind: "wave",
      chip: 0,
      pitch: SNES_PITCH,
      volume: SNES_VOLUME,
      waveform: { samples: 16, bits: 4 },
      envelope: SNES_ENVELOPE,
      panning: "lr-level",
    },
    {
      id: "wave2",
      kind: "wave",
      chip: 0,
      pitch: SNES_PITCH,
      volume: SNES_VOLUME,
      waveform: { samples: 16, bits: 4 },
      envelope: SNES_ENVELOPE,
      panning: "lr-level",
    },
    {
      id: "triangle",
      kind: "triangle",
      chip: 0,
      pitch: SNES_PITCH,
      // Unlike the NES's, this triangle has a volume register like every other
      // voice: it is a triangle because of the waveform, not because of the wiring.
      volume: SNES_VOLUME,
      envelope: SNES_ENVELOPE,
      panning: "lr-level",
    },
    {
      id: "noise",
      kind: "noise",
      chip: 0,
      volume: SNES_VOLUME,
      // The noise clock is one five-bit field in `FLG`, shared by every voice
      // `NON` selects — which is why exactly one voice here is a noise voice.
      noise: { periods: 32, tonalMode: false },
      envelope: SNES_ENVELOPE,
      panning: "lr-level",
    },
  ],
  driver: {
    // The sound processor has three timers of its own, so the driver's clock is
    // not borrowed from the picture on this console — the only one in the set
    // where that is true.
    sources: ["spc-timer", "vblank"],
    frameRate: { num: 21477272, den: 357368 },
    timerRange: [32, 500],
    // Eight voices stating themselves at once is about fifty writes, and the
    // sound processor has eight thousand cycles between ticks at 125 Hz — some
    // thirty of them per write. The bound here is the packed format's own
    // ceiling rather than the CPU's, which is the only console in the set where
    // that is true.
    writesPerTick: 120,
  },
  // A schedule lives in the sound chip's own RAM rather than in the cartridge,
  // and it gets there by being uploaded at boot — so it costs cartridge *and*
  // sample RAM, and the second budget is the tighter one on a long track.
  budgets: { romBytes: 16384, sampleRamBytes: 0xc000 },
  mixing: { channels: 2, linear: true },
  docs: { sources: SNES_SOURCES },
};

const GBA_SOURCES = [
  "GBATEK — GBA Sound Controller: https://problemkaputt.de/gbatek.htm#gbasoundcontroller",
  "GBATEK — GBA Sound Channels 1-4: https://problemkaputt.de/gbatek.htm#gbasoundchannel1sweep",
  "GBATEK — Timers: https://problemkaputt.de/gbatek.htm#gbatimers",
];

/** The Game Boy Advance's system clock, which its timers count. */
const GBA_CLOCK = 16777216;

/** The rate the two sample converters are clocked at, and the mixer's own. */
const GBA_PCM_RATE = 32768;

/**
 * A direct-sound voice's pitch lattice, which counts *up* like the S-DSP's.
 *
 * A voice plays its waveform at `32768 × step / 65536` samples a second and the
 * built-in waveforms are one cycle in sixteen samples, so the note is
 * `32768 × step / (16 × 65536)` — uniform steps of 0.03 Hz, which is finer than
 * anything else in the set by two orders of magnitude. The step is
 * twenty-four bits, so the ceiling is not the register's.
 */
const GBA_PCM_PITCH = {
  kind: "multiplier" as const,
  clockHz: GBA_PCM_RATE,
  step: 16 * 65536,
  minDivider: 1,
  maxDivider: 0xffffff,
};

/** Eight bits of level, and it is a level rather than an attenuation. */
const GBA_PCM_VOLUME = { steps: 256, law: "linear" as const };

/** One of the mixer's sample voices. */
function gbaPcmChannel(id: string, kind: "pulse" | "wave" | "noise"): AudioChannelSpec {
  return {
    id,
    kind,
    chip: 1,
    ...(kind === "noise" ? {} : { pitch: GBA_PCM_PITCH }),
    volume: GBA_PCM_VOLUME,
    ...(kind === "pulse" ? { duties: [0.125, 0.25, 0.5] } : {}),
    ...(kind === "wave" ? { waveform: { samples: 16, bits: 8 } } : {}),
    ...(kind === "noise" ? { noise: { periods: 1, tonalMode: false } } : {}),
    // Every level a voice can take is a driver write, because the mixing is the
    // driver's: there is no envelope generator on this half of the hardware.
    envelope: { kind: "none" as const },
    panning: "lr-level",
  };
}

/**
 * The Game Boy Advance, which is the only console in the set with *both* kinds
 * of sound hardware on one board.
 *
 * Four Game Boy channels, unchanged from the machine this console is named
 * after — the same registers under a permuted map, which is why chip 0 is
 * `gb-apu` and not a second model — and beside them two eight-bit converters
 * fed by DMA at a timer's rate. What those two carry is a *software mix*, so the
 * six voices declared for them are the demaker's rather than the hardware's, in
 * exactly the sense the Super Nintendo's eight are: the machine offers sample
 * playback and how many voices fit in it is a CPU question, which
 * `@demake/chip`'s `GbaPcm` answers at six.
 *
 * Ten voices, then, and it is the largest palette here — the Mega Drive's ten
 * being the other, and split differently. Nothing about a demade arrangement on
 * this console is mostly about what had to go.
 */
export const gbaAudio: AudioSpec = {
  chips: ["gb-apu", "gba-pcm"],
  channels: [
    {
      id: "pulse1",
      kind: "pulse",
      chip: 0,
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
    gbaPcmChannel("sample1", "pulse"),
    gbaPcmChannel("sample2", "pulse"),
    gbaPcmChannel("sample3", "wave"),
    gbaPcmChannel("sample4", "wave"),
    gbaPcmChannel("sample5", "wave"),
    gbaPcmChannel("sample6", "noise"),
  ],
  driver: {
    // Four hardware timers, two of which are spoken for by the sample
    // converters — so a driver has one of its own and does not have to ride the
    // picture, which is the Game Boy's arrangement rather than the NES's.
    sources: ["timer", "vblank"],
    frameRate: { num: GBA_CLOCK, den: 280896 },
    timerRange: [16, 4096],
    // The processor runs at four times a Game Boy's and every write is a store
    // to an ordinary address rather than a port, so the tick's budget is the
    // packed format's ceiling rather than the CPU's.
    writesPerTick: 120,
  },
  budgets: { romBytes: 65536 },
  mixing: { channels: 2, linear: true },
  docs: { sources: GBA_SOURCES },
};

/** NTSC Master System / SG-1000: 3579545 / (262 × 228) ≈ 59.92 Hz. */
const SMS_FRAME_RATE = { num: 3579545, den: 59736 };

export const smsAudio: AudioSpec = psgAudio({ stereo: false, frameRate: SMS_FRAME_RATE });
export const ggAudio: AudioSpec = psgAudio({ stereo: true, frameRate: SMS_FRAME_RATE });
export const sg1000Audio: AudioSpec = psgAudio({ stereo: false, frameRate: SMS_FRAME_RATE });

/** The YM2612's clock on an NTSC Mega Drive: the master clock divided by seven. */
const YM2612_CLOCK = 7670453;

/**
 * One four-operator FM voice.
 *
 * The pitch lattice is not a divider here — it is a *phase increment*, which is
 * the opposite arrangement and the reason this is the only channel in the set
 * whose resolution improves as the note rises rather than collapsing. A whole
 * cycle is 2^20 increment units at the chip's own 53.267 kHz, and the F-number
 * is eleven bits shifted by a three-bit block, so the lattice is expressed as a
 * divider of the same total span: 2^20 / (fnum << block).
 *
 * Volume is total level: seven bits of attenuation at 0.75 dB a step, which is
 * finer than anything else on this board by a factor of eight and is what lets
 * an FM part actually swell.
 */
function fmChannel(id: string): AudioChannelSpec {
  return {
    id,
    kind: "fm",
    chip: 0,
    // Expressed as the equivalent divider: f = clock / (144 * 2^20 / (fnum<<block)),
    // so `step` is the 144 clocks a sample takes and the divider spans the
    // eleven-bit F-number over eight blocks.
    pitch: { clockHz: YM2612_CLOCK, step: 144, minDivider: 4, maxDivider: 1 << 20 },
    volume: { steps: 128, law: "db", stepDb: 0.75 },
    // The envelope is the chip's, and it is a full four-stage one rather than
    // the decay-only ramps every other chip here offers — so a swell, a pluck
    // and a pad are all patches rather than driver writes.
    envelope: { kind: "decay", ratePerSecond: 17756 },
    panning: "lr-enable",
  };
}

/**
 * The Mega Drive: six FM voices and the four PSG ones, on two chips.
 *
 * **Ten voices, which is what this console has.** The PSG half is a Master
 * System's chip and not by resemblance — the same SN76489 fed by the same master
 * clock divided by fifteen, and an NTSC frame is 262 lines of 3420 master cycles,
 * which is 228 *PSG* cycles a line, so its numbers reduce to exactly
 * {@link SMS_FRAME_RATE}. The FM half is a YM2612 at master over seven.
 *
 * The two are one instrument rather than two, which is why they are one spec: the
 * arranger assigns a part to whichever of the ten voices suits it, and "this is
 * an FM voice and that is a square wave" is a property of the channel it lands
 * on. `BoundWrite.chip` is how a write says which of them it addresses.
 */
export const mdAudio: AudioSpec = {
  chips: ["ym2612", "sn76489"],
  channels: [
    fmChannel("fm1"),
    fmChannel("fm2"),
    fmChannel("fm3"),
    fmChannel("fm4"),
    fmChannel("fm5"),
    fmChannel("fm6"),
    ...psgAudio({ stereo: false, frameRate: SMS_FRAME_RATE }).channels.map((channel) => ({
      ...channel,
      // The PSG is the *second* chip here, where on a Master System it is the
      // only one; every other number about it is identical.
      chip: 1,
      id: `psg-${channel.id}`,
    })),
  ],
  driver: {
    sources: ["timer", "vblank"],
    frameRate: SMS_FRAME_RATE,
    // The YM2612's timer A is a real clock a driver can hold a tempo on, unlike
    // this VDP's line interrupt — 10 bits at the chip's own sample rate.
    timerRange: [52, 500],
    // Far larger than any 8-bit console's, and it is arithmetic rather than
    // generosity. An NTSC frame is 127,856 cycles of a 7.67 MHz 68000; a write
    // here is a byte store to an absolute address, about 24 cycles with the
    // packed-data fetch around it. Twelve per cent of a frame is therefore about
    // 640 writes, and the driver runs in the main loop rather than the blanking
    // interval so that is a real twelve per cent rather than a raster deadline.
    //
    // The peak is not the steady state: installing six four-operator patches at
    // the head of a track is ~500 writes and every tick after it is a few dozen.
    // The budget has to cover the peak, because that is the tick that would
    // overrun.
    writesPerTick: 640,
  },
  budgets: { romBytes: 262144 },
  mixing: { channels: 2, linear: true },
  docs: {
    sources: [
      ...PSG_SOURCES,
      "Sega — YM2612 application manual (register map, F-number, key-on slot order)",
      "Plutiedev — YM2612 from the 68000: https://plutiedev.com/ym2612-registers",
    ],
  },
};

const NDS_SOURCES = [
  "GBATEK — DS Sound Channels: https://problemkaputt.de/gbatek.htm#dssound",
  "GBATEK — DS Sound Control Registers: https://problemkaputt.de/gbatek.htm#dssoundcontrolregisters",
  "GBATEK — DS Timers (the ARM7's, which the driver rides): https://problemkaputt.de/gbatek.htm#dstimers",
];

/**
 * A channel's timer clock: half the 33.513982 MHz the machine runs at.
 *
 * One lattice with three meanings, which is this chip's whole arrangement: the
 * period a channel reloads is a *sample* rate for one playing PCM, an eighth of a
 * square wave's frequency for one generating a duty, and a shift rate for the
 * noise register. So the three kinds below differ only in `step`.
 */
const NDS_TIMER_HZ = 16756991;

/** Samples in one cycle of a built-in waveform (`binding/nds-bank.ts`). */
const NDS_WAVE_SAMPLES = 32;

/** Seven bits of multiplier, before a divider that is not used for notes. */
const NDS_VOLUME = { steps: 128, law: "linear" as const };

/**
 * A sample channel's pitch lattice.
 *
 * A single-cycle waveform of {@link NDS_WAVE_SAMPLES} samples played one sample
 * per timer period is a note of `clock / (samples × period)`, so the lattice is a
 * divider with a step of the cycle length. Sixteen bits of period puts the floor
 * at 8 Hz and the ceiling far above hearing; what it costs is the divider's usual
 * crowding at the bottom, which is the opposite of the Super Nintendo's sample
 * player and the price of a timer that counts down.
 */
const NDS_SAMPLE_PITCH = {
  clockHz: NDS_TIMER_HZ,
  step: NDS_WAVE_SAMPLES,
  minDivider: 1,
  maxDivider: 0xffff,
};

/**
 * A duty channel's, which is the same timer over eight steps of a square wave.
 *
 * `f = clock / (8 × period)`, from 32 Hz to well past the audible — the honest
 * hardware range, and the reason the arranger never has to fold a bass line up an
 * octave on this console.
 */
const NDS_PSG_PITCH = {
  clockHz: NDS_TIMER_HZ,
  step: 8,
  minDivider: 1,
  maxDivider: 0xffff,
};

/** One of the eight channels that can only play a sample. */
function ndsSampleChannel(id: string, kind: "pulse" | "wave"): AudioChannelSpec {
  return {
    id,
    kind,
    chip: 0,
    pitch: NDS_SAMPLE_PITCH,
    volume: NDS_VOLUME,
    ...(kind === "pulse" ? { duties: [0.125, 0.25, 0.5] } : {}),
    ...(kind === "wave" ? { waveform: { samples: NDS_WAVE_SAMPLES, bits: 8 } } : {}),
    // No envelope generator anywhere on this chip: a note's whole dynamic shape
    // is one volume byte a tick, which is what makes sixteen channels affordable
    // for a driver that has a processor to itself.
    envelope: { kind: "none" },
    panning: "lr-level",
  };
}

/**
 * The Nintendo DS, and it is the widest palette in the set by a factor of three.
 *
 * Sixteen channels on one chip. Eight of them are sample players and nothing else
 * — the Super Nintendo's arrangement, so their kinds are the *demaker's*
 * assignment and what makes one a pulse or a saw is which built-in waveform the
 * driver points it at. Six more can be switched to a square-wave generator with a
 * duty of their own, which is a Game Boy's pulse channel four times over, and the
 * last two to a noise shift register.
 *
 * Three things about it have no precedent here. **Panning is a level**, seven
 * bits of position per channel, where every other console in the set offers one
 * bit each way or nothing at all. **Nothing is shared**: there is no `NR51`, no
 * `$4015` and no key-on pulse, so two streams sharing this chip never write the
 * same register and the driver merges nothing. And **the driver is not on the
 * game's processor** — the sound registers answer the ARM7 alone — so a frame the
 * game overran costs it no tempo, which on this list only the Super Nintendo can
 * also say.
 */
export const ndsAudio: AudioSpec = {
  chips: ["nds-spu"],
  channels: [
    ndsSampleChannel("sample1", "pulse"),
    ndsSampleChannel("sample2", "pulse"),
    ndsSampleChannel("sample3", "pulse"),
    ndsSampleChannel("sample4", "pulse"),
    ndsSampleChannel("sample5", "wave"),
    ndsSampleChannel("sample6", "wave"),
    ndsSampleChannel("sample7", "wave"),
    ndsSampleChannel("sample8", "wave"),
    ...["pulse1", "pulse2", "pulse3", "pulse4", "pulse5", "pulse6"].map((id): AudioChannelSpec => ({
      id,
      kind: "pulse",
      chip: 0,
      pitch: NDS_PSG_PITCH,
      volume: NDS_VOLUME,
      // Seven of the eight duty settings are a square wave; the eighth is a
      // constant, which GBATEK's table calls 0% and a listener calls silence.
      duties: [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
      envelope: { kind: "none" },
      panning: "lr-level",
    })),
    ...["noise1", "noise2"].map((id): AudioChannelSpec => ({
      id,
      kind: "noise",
      chip: 0,
      volume: NDS_VOLUME,
      // The period is the channel's own sixteen-bit timer rather than a table
      // of divisors, so the reachable rates are dense; sixty-four of them is
      // what the arranger and the sound demaker index against, exactly as they
      // do on a Game Boy.
      noise: { periods: 64, tonalMode: false },
      envelope: { kind: "none" },
      panning: "lr-level",
    })),
  ],
  driver: {
    // The ARM7's four timers, none of which anything else in a demade cartridge
    // uses — that processor's whole job here is the sound.
    sources: ["timer", "vblank"],
    // 33513982 / (355 × 263 × 6): the same raster the ARM9's `VCOUNT` counts.
    frameRate: { num: 33513982, den: 560190 },
    timerRange: [16, 4096],
    // The one console here where the honest bound is genuinely large, and it is
    // the CPU's rather than the format's. A driver tick at 120 Hz is 279,283
    // ARM7 cycles and the processor has *nothing else to do with them* — the
    // sound hardware is all it drives — so twelve per cent of a tick at some
    // sixteen cycles a packed write is around two thousand. Sixteen channels
    // stating themselves at once is about a hundred, and the chip's whole
    // initialisation is a hundred and thirty, so a demade schedule is two orders
    // of magnitude inside it. That is a fact about a machine with a processor to
    // spare, not a budget nobody checked (the Mega Drive's arithmetic, on a tick
    // twice as long and with no game in it).
    writesPerTick: 1920,
  },
  budgets: { romBytes: 262144 },
  mixing: { channels: 2, linear: true },
  docs: { sources: NDS_SOURCES },
};
