/**
 * Level B: our chip models against a third-party core's *samples* (doc 16 §The proof).
 *
 * Level A already diffs the register writes exactly — the ROM boots in a core we
 * own and every write it makes is compared with the `ChipScript`, tick for tick,
 * with no tolerance. What that cannot see is the half below the registers:
 * whether our *model of the chip* turns those writes into the same sound. A duty
 * table off by one, a noise polynomial with the wrong tap, a volume law that is
 * linear where the hardware is logarithmic — each produces a perfect register
 * stream and the wrong audio.
 *
 * So this boots a standalone audio cartridge in a **third-party** core, captures
 * what comes out of its audio callback, and compares it with `render()`'s output
 * from the same schedule.
 *
 * ### Why the comparison is spectral
 *
 * A waveform diff is not available here and pretending otherwise would produce a
 * flaky test rather than a strict one. Three things differ legitimately between
 * a core's output and ours, and doc 16 says so: a core applies **its own
 * filtering**, normalises to **its own level**, and starts after **its own boot
 * latency**. Measured on fceumm, the level difference alone is 19%, and
 * cross-correlating the waveforms locks onto the music's own periodicity rather
 * than the true alignment — the best lag wanders between 899 and 4456 samples
 * across one capture.
 *
 * What survives all three is the **long-term average magnitude spectrum**. It is
 * blind to phase, to alignment and to a constant gain, and it is exactly what a
 * wrong chip model moves: pitch, timbre and the balance between voices all live
 * in it. Compared as a cosine similarity, which normalises the level away.
 *
 * ### The threshold, and why it means something
 *
 * The number is 0.99, and it was chosen after measuring what wrong answers score
 * rather than before. On the NES capture this suite runs:
 *
 * | what was compared with the core | similarity |
 * | --- | --- |
 * | our render of the same schedule | **0.9992** |
 * | **the APU with its duty bit inverted** | **0.9801** |
 * | the same tune arranged for a Game Boy | 0.9492 |
 * | our render, 6% sharp | 0.8826 |
 * | white noise | 0.4236 |
 * | one square wave | 0.1746 |
 *
 * The second row is the one that decides the threshold, and it is not a
 * constructed comparison — it is `nes-apu.ts` with `ch.duty = v >> 6` changed to
 * `(v >> 6) ^ 1`, which is precisely the bug this level exists to catch: the
 * register stream stays *perfect*, Level A still passes, and the chip plays the
 * wrong waveform. It scores 0.9801, so the gate sits above it and below the
 * correct model's 0.9992.
 *
 * `discriminates` below keeps that honest in the suite itself, with the nearest
 * *plausible* wrong answer that needs no mutation: the same music, same tempo,
 * same structure, arranged for a different chip.
 *
 * ### What is rendered is the schedule *with* its boot, and that is not obvious
 *
 * A cartridge performs its chip's initialisation in the boot and the rest of the
 * schedule from its clock, so `BuiltAudioRom.performed` is the schedule **minus**
 * the boot writes. That is exactly right for Level A, where a capture starts at
 * the first tick and diffing against the caller's copy would ask the driver for
 * writes it correctly made earlier — and it is exactly wrong here, because those
 * writes are chip *state* and a render that never performs them plays something
 * else.
 *
 * On four of the five families it makes no difference at all: their boot is a
 * handful of latches the schedule's own first tick repeats, so `stripBoot`
 * removes nothing and the two renders are sample-identical. On the two whose
 * boot carries waveforms it is the difference between the track and silence —
 * a PC Engine render loses 37% of its level (0.0905 RMS against 0.1431) and a
 * WonderSwan's loses the four pitched channels outright, because that chip reads
 * its tables from an address the stripped schedule never states. So this renders
 * `arranged.script`, which is the boot followed by everything else.
 *
 * ### The WonderSwan is absent, and what is left of that is one voice's level
 *
 * `rom/wsc.ts` builds a standalone cartridge and beetle-wswan is provisioned by
 * the same script as the four cores above, so the row costs one line — and it
 * scores **0.8973**, which is under the gate. It is not the output filtering
 * this file already warns about: restricting the comparison to below 1.7 kHz
 * moves it by 0.002.
 *
 * It is the **noise channel**, and dropping the drum part from the arrangement
 * is what says so — the same tune, same core, same everything else, scores
 * **0.9978**.
 *
 * Half of that gap is closed and the half that is left is measured. Pointed at
 * one held note at a time, this comparison found `WsSound`'s shift register
 * feeding back the wrong pair of bits: it reproduced one of the eight documented
 * sequence lengths and missed seven, which is white noise where the hardware has
 * eight colours (`packages/chip/test/ws-sound.test.ts` now pins all eight
 * against the table). With that fixed the noise voice's *spectrum* lands beside
 * the core's — 54 Hz against 43, 118 against 54 — where it had been 1497 against
 * 140.
 *
 * What remains is a **level**, and it is a pure gain rather than a shape. Our
 * pitched voices come out 1.063× the core's and our noise voice 1.734×, and the
 * second number is flat across the band — 1.729 below 4 kHz, 1.735 below 22 —
 * so it is not the filtering caveat and not aliasing in a broadband source,
 * which are the two things that would show as a tilt. Relative to the pitched
 * voices the core's noise is 0.61× ours.
 *
 * On that one the documentation is on our side: the WSdev wiki says the shift
 * register's bit is "used as if it were a wavetable sample: 0 = 0, 1 = 15",
 * which is the same amplitude a wavetable channel has before its volume nibble,
 * and is exactly what `WsSound` does — at a duty of 0.500 on the long modes,
 * measured over a whole period. So this reads as Mednafen attenuating that voice
 * rather than as a gap in the model, and the row stays out because a
 * *cross-check* whose two sides disagree by a known constant is not evidence
 * about the chip in either direction. Level A is green on that console for a
 * track *and* an effect. Doc 13 §A2.5 records it.
 *
 * Source: WSdev wiki — Sound (https://ws.nesdev.org/wiki/Sound).
 *
 * Needs `pnpm toolchains && pnpm emulator`; self-skips without them.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { arrangeScore, buildAudioRom, parseMidi, render } from "@demake/audio";
import { hann, spectrum } from "@demake/audio";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");

/**
 * The consoles this can run, and what each needs.
 *
 * A console qualifies when it has **both** a standalone audio cartridge (doc 13
 * §A5) and a libretro core — the cartridge because Level B needs a ROM whose
 * only job is the schedule, and a third-party core because our own would be
 * comparing a model with itself.
 */
const TARGETS = [
  { console: "nes", core: "fceumm_libretro.so", frames: 900 },
  { console: "sms", core: "genesis_plus_gx_libretro.so", frames: 900 },
  { console: "md", core: "genesis_plus_gx_libretro.so", frames: 900 },
  { console: "pce", core: "mednafen_pce_fast_libretro.so", frames: 900 },
] as const;

/** Frames of the average spectrum; 2048 at 48 kHz is ~23 Hz a bin. */
const SIZE = 2048;
const WINDOW = hann(SIZE);

/** The similarity a correct model must reach. See the table above. */
const THRESHOLD = 0.99;

/** Mono float samples from a 16-bit WAV, whatever its channel count. */
function readWav(path: string): { rate: number; samples: Float32Array } {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  let rate = 0;
  let channels = 1;
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
    }
    if (id === "data") {
      const frames = Math.floor(size / 2 / channels);
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) {
        samples[i] = view.getInt16(at + 8 + i * channels * 2, true) / 32768;
      }
      return { rate, samples };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${path}`);
}

/** The average magnitude spectrum over a whole signal. */
function averageSpectrum(samples: Float32Array): Float64Array {
  const acc = new Float64Array(SIZE / 2);
  let frames = 0;
  for (let at = 0; at + SIZE <= samples.length; at += SIZE) {
    const magnitude = spectrum(samples.subarray(at, at + SIZE), WINDOW);
    for (let i = 0; i < acc.length; i += 1) acc[i] += magnitude[i] as number;
    frames += 1;
  }
  for (let i = 0; i < acc.length; i += 1) acc[i] /= Math.max(1, frames);
  return acc;
}

/**
 * Cosine similarity of two spectra, which is what makes level irrelevant.
 *
 * The first two bins are skipped: they are DC and the one above it, where a
 * core's high-pass and ours differ by construction and no note lives.
 */
function similarity(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 2; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

const MIDI = new URL("../../demotic/fixtures/projects/quest/music/overworld.mid", import.meta.url);

describe("Level B — chip models against a third-party core", () => {
  for (const target of TARGETS) {
    const core = join(TC, "libretro", "cores", target.core);
    const ready = existsSync(RETRORUN) && existsSync(core);
    const maybe = ready ? it : it.skip;

    maybe(
      `${target.console}: the cartridge sounds like the schedule`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), `demake-levelb-${target.console}-`));
        const system = join(dir, "system");
        mkdirSync(system, { recursive: true });

        const score = parseMidi(new Uint8Array(readFileSync(MIDI)));
        const arranged = arrangeScore(score, { console: target.console });
        const built = await buildAudioRom(arranged.script, { title: "LEVELB" });
        const romPath = join(dir, `audio${built.suffix}`);
        writeFileSync(romPath, built.bytes);

        const capture = join(dir, "core.wav");
        execFileSync(
          RETRORUN,
          [
            core,
            romPath,
            String(target.frames),
            join(dir, "frame.ppm"),
            system,
            `audio_out=${capture}`,
          ],
          { stdio: "pipe" },
        );

        const theirs = readWav(capture);
        expect(theirs.samples.length).toBeGreaterThan(theirs.rate); // at least a second

        // Rendered at the *core's* rate, so no resampler sits between the two
        // things being compared — and rendered from the schedule *including* its
        // boot, because those writes are chip state rather than a power-up to be
        // discounted (§What is rendered). `built.performed` is the right
        // comparand for a register diff and the wrong one for a render.
        const ours = render(arranged.script, { sampleRate: theirs.rate });

        const match = similarity(
          averageSpectrum(ours.channels[0] as Float32Array),
          averageSpectrum(theirs.samples),
        );
        expect(match).toBeGreaterThan(THRESHOLD);
      },
      120_000,
    );
  }

  const nesCore = join(TC, "libretro", "cores", "fceumm_libretro.so");
  const nesReady = existsSync(RETRORUN) && existsSync(nesCore);

  (nesReady ? it : it.skip)(
    "discriminates: the same tune on a different chip fails the gate",
    async () => {
      // Without this the threshold is a number nobody has justified. The nearest
      // *plausible* wrong answer is the same music arranged for another console —
      // same notes, same tempo, same structure, different chip — and it has to
      // fail, or the gate is measuring "is this music" rather than "is this our
      // model of this chip".
      const dir = mkdtempSync(join(tmpdir(), "demake-levelb-discriminate-"));
      const system = join(dir, "system");
      mkdirSync(system, { recursive: true });

      const score = parseMidi(new Uint8Array(readFileSync(MIDI)));
      const nes = arrangeScore(score, { console: "nes" });
      const built = await buildAudioRom(nes.script, { title: "LEVELB" });
      const romPath = join(dir, `audio${built.suffix}`);
      writeFileSync(romPath, built.bytes);

      const capture = join(dir, "core.wav");
      execFileSync(
        RETRORUN,
        [nesCore, romPath, "900", join(dir, "frame.ppm"), system, `audio_out=${capture}`],
        { stdio: "pipe" },
      );
      const theirs = averageSpectrum(readWav(capture).samples);

      const gb = render(arrangeScore(score, { console: "gb" }).script, { sampleRate: 48000 });
      const wrong = similarity(averageSpectrum(gb.channels[0] as Float32Array), theirs);
      expect(wrong).toBeLessThan(THRESHOLD);
    },
    120_000,
  );
});
