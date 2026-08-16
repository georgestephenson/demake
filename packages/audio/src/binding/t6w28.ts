/**
 * The T6W28 binding (both Neo Geo Pockets).
 *
 * The SN76489's register map with the poverty that shapes doc 17's whole
 * argument — no envelope generator, so every volume shape is a write — and one
 * thing that chip has not got: **stereo that is a level rather than a switch**.
 * Four bits an ear per channel, so a part sits where the arrangement puts it
 * instead of hard left, hard right or both.
 *
 * Three things about the encoding follow from the hardware and none of them is
 * the Sega part restated.
 *
 *   - **The port is the register.** There are two write addresses and each owns
 *     its side's four attenuators, so a level change costs *two* writes where a
 *     Master System's costs one. `BoundWrite.reg` therefore carries the port —
 *     {@link T6W28_LEFT} or {@link T6W28_RIGHT} — which is exactly what the
 *     packed driver format already puts in that field for the Sega parts, and
 *     what makes a run of writes to one side one run.
 *   - **The tone periods live on the left port and the noise's on the right.**
 *     That is the chip's asymmetry and not a choice here: a note is written
 *     through one port and its stereo image through both.
 *   - **There is no shared register at all.** A Game Gear's stereo latch is one
 *     byte two streams both write, and this chip has nothing of the kind — the
 *     panning is inside each channel's own attenuator. So a game emits no merge
 *     routine, which is the Master System's answer reached for the opposite
 *     reason: not because the hardware pans less, but because it pans *per
 *     channel*.
 *
 * The channel is still in the data byte and it is still latched, so the packing
 * discipline the Sega drivers run under applies here unchanged: every run opens
 * with a latch byte, and `checkLatchDiscipline` refuses a schedule where it does
 * not.
 *
 * **And the placement is spent rather than switched.** `ChannelFrame.pan` is a
 * signed position, so a voice sits anywhere across the image: the level is
 * scaled per side by `panGains` and then inverted into each attenuator, which
 * is what the spec's `lr-level` has always claimed the hardware does. It was a
 * pair of booleans once — full on or fully cut, the Game Gear's answer through
 * a per-channel attenuator — and that was the last thing about this chip a
 * demaker could not reach.
 */

import { NGP_T1CLK, NGP_T1CLK_DIVISORS, type AudioSpec } from "@demake/core";

import { snapPitch, snapVolume } from "../pitch.js";
import { attenuate, panGains } from "./pan.js";
import type { BoundWrite, ChipBinding, DriverRateFit } from "./types.js";

/** The two write ports, as this binding's register numbers. */
export const T6W28_RIGHT = 0;
export const T6W28_LEFT = 1;

/** The chip's clock: the console's 6.144 MHz crystal, halved. */
const T6W28_CLOCK = 3_072_000;

/**
 * The processor's own 8-bit timers, which are what a standalone driver rides.
 *
 * A TMP95C061 feeds its four 8-bit interval timers from a shared 9-bit
 * prescaler, and a driver above the frame rate is a timer's rather than the
 * picture's. The frame is still the candidate every other rate has to beat,
 * because a *game*'s two streams share one interrupt with the picture (doc 16
 * §Two streams, one clock).
 *
 * These are an **upper** timer's — 1 or 3 — rather than the union over all
 * four, and that is the hardware rather than a simplification. `NGP_T1CLK` is
 * where the machine says so: a lower timer takes the external pin or φT1, φT4
 * and φT16, and an upper one takes its partner's comparator output or φT1, φT16
 * and φT256. No single timer offers all four internal clocks, and a driver
 * rides one — so offering the union would promise a rate whichever timer the
 * driver picked could not keep. The upper timer is the pick because φT256 is
 * the only clock that reaches the bottom of the useful band, and it costs
 * nothing: φT4 is a lower timer's, and the one rate it contributes inside the
 * window below (750 Hz, at a full reload) is one φT256 also hits exactly.
 *
 * The numbers are divisions of {@link T6W28_CLOCK} — the crystal *halved*,
 * which is the system clock and is also what this chip runs at — so each is
 * half the datasheet's division of `fc`. Cross-checked against the same
 * document's serial baud table, which tabulates `fc / (TREG2 × 8 × 16)` at
 * *this console's* 6.144 MHz and lists 48 Kbps for a reload of 1: that is
 * φT1 = fc/8 and nothing else.
 *
 * Derived from `core`'s own description rather than restated, because a second
 * copy of a clock division is a driver that programs one prescaler and a
 * schedule that was fitted to another.
 */
const TIMER_PRESCALERS: readonly number[] = [
  NGP_T1CLK_DIVISORS[NGP_T1CLK.t1] as number,
  NGP_T1CLK_DIVISORS[NGP_T1CLK.t16] as number,
  NGP_T1CLK_DIVISORS[NGP_T1CLK.t256] as number,
];

export function t6w28Binding(console: string, spec: AudioSpec): ChipBinding {
  return {
    console,
    chips: spec.chips,
    spec,

    init(): BoundWrite[] {
      // Silence everything, on both sides: four attenuation latches a port.
      const writes: BoundWrite[] = [];
      for (const port of [T6W28_RIGHT, T6W28_LEFT]) {
        for (const latch of [0x9f, 0xbf, 0xdf, 0xff]) writes.push({ reg: port, value: latch });
      }
      return writes;
    },

    encode(next, prev): BoundWrite[] {
      const writes: BoundWrite[] = [];

      for (let i = 0; i < spec.channels.length; i += 1) {
        const channel = spec.channels[i]!;
        const frame = next[i]!;
        const before = prev?.[i];
        const isNoise = channel.kind === "noise";
        const steps = channel.volume.steps;

        // Centre is full on both sides, which is what a part that does not ask
        // to be placed gets — and it is what makes a mono arrangement here
        // sound like a Master System's. Anything else is spent across the two
        // attenuators, which is the whole reason this chip's spec says
        // `lr-level`: the level is scaled per side and then inverted into an
        // attenuation, so a voice sits where the arranger put it rather than
        // being switched out of one speaker.
        const sides = (frameAt: { on: boolean; level: number; pan?: number }) => {
          if (!frameAt.on) return [steps - 1, steps - 1] as const;
          const level = snapVolume(channel.volume, frameAt.level);
          const gains = panGains(frameAt.pan);
          return [
            steps - 1 - attenuate(level, gains.left),
            steps - 1 - attenuate(level, gains.right),
          ] as const;
        };
        const [leftAtt, rightAtt] = sides(frame);
        const [beforeLeft, beforeRight] =
          before === undefined ? ([-1, -1] as const) : sides(before);

        if (isNoise) {
          // Control changes reset the shift register, so they are written only
          // when the colour actually changes or a new hit lands — and they go to
          // the right-hand port, because that is where this chip keeps the noise
          // generator's own registers.
          const tonal = frame.noiseTonal === true;
          const rate = noiseRate(frame.noisePeriod ?? 1);
          const changed =
            before === undefined ||
            frame.retrigger === true ||
            before.noiseTonal !== frame.noiseTonal ||
            noiseRate(before.noisePeriod ?? 1) !== rate;
          if (changed && frame.on) {
            // Rate 3 divides the noise's *own* register, which is the whole of
            // what this part adds over an SN76489 — where that rate follows tone
            // channel 2 and costs a voice. So the deepest colour writes a
            // divisor rather than borrowing one, and the three tones stay free.
            // It goes in front of the control byte because the control byte
            // resets the shift register, and it is written where tone 2's period
            // would be on the *right* port, which is the one place on this chip
            // where a channel field names something other than its channel.
            if (rate === NOISE_OWN_RATE) {
              writes.push({
                reg: T6W28_RIGHT,
                value: 0x80 | (2 << 5) | (NOISE_DIVIDER & 0x0f),
              });
              writes.push({ reg: T6W28_RIGHT, value: (NOISE_DIVIDER >> 4) & 0x3f });
            }
            writes.push({ reg: T6W28_RIGHT, value: 0xe0 | (tonal ? 0 : 0x04) | rate });
          }
          if (leftAtt !== beforeLeft) writes.push({ reg: T6W28_LEFT, value: 0xf0 | leftAtt });
          if (rightAtt !== beforeRight) writes.push({ reg: T6W28_RIGHT, value: 0xf0 | rightAtt });
          continue;
        }

        if (frame.on && channel.pitch) {
          const period = snapPitch(channel.pitch, frame.hz).divider;
          const beforePeriod =
            before?.on && channel.pitch ? snapPitch(channel.pitch, before.hz).divider : -1;
          if (period !== beforePeriod) {
            // The left port, because that is where the tone periods are — and
            // both bytes go there, so the latch this run opens with is its own.
            writes.push({ reg: T6W28_LEFT, value: 0x80 | (i << 5) | (period & 0x0f) });
            writes.push({ reg: T6W28_LEFT, value: (period >> 4) & 0x3f });
          }
        }
        if (leftAtt !== beforeLeft) {
          writes.push({ reg: T6W28_LEFT, value: 0x90 | (i << 5) | leftAtt });
        }
        if (rightAtt !== beforeRight) {
          writes.push({ reg: T6W28_RIGHT, value: 0x90 | (i << 5) | rightAtt });
        }
      }

      return writes;
    },

    fitRate(desiredHz): DriverRateFit {
      // The frame interrupt is always available and always exact, so it is the
      // candidate every other one has to beat rather than a fallback. It is also
      // the only clock a *game* gets, because a game's two streams share one
      // interrupt with the picture.
      const frameHz = spec.driver.frameRate.num / spec.driver.frameRate.den;
      let best: DriverRateFit = { rate: spec.driver.frameRate, source: "vblank" };
      let bestError = Math.abs(frameHz - desiredHz);
      // An 8-bit timer over one of its three prescalers, which is how a
      // *standalone* driver holds a tempo the picture cannot express. The
      // period in input clocks *is* the reload rather than one more than it —
      // the up-counter is cleared to zero on the match — so a full 256 is
      // written as zero, which is what `& 0xff` below says. The datasheet's own
      // worked example is the check: 62500 counts of φT16 is `TREG = F424H`.
      for (const prescaler of TIMER_PRESCALERS) {
        for (let reload = 1; reload <= 256; reload += 1) {
          const den = prescaler * reload;
          const hz = T6W28_CLOCK / den;
          if (hz < 30 || hz > 800) continue;
          const error = Math.abs(hz - desiredHz);
          if (error < bestError - 1e-12) {
            bestError = error;
            best = {
              rate: { num: T6W28_CLOCK, den },
              source: "timer",
              divisor: reload & 0xff,
            };
          }
        }
      }
      return best;
    },
  };
}

/** The rate that divides the noise's own register rather than a fixed amount. */
const NOISE_OWN_RATE = 3;

/**
 * The divisor the deepest noise colour uses.
 *
 * The register's widest value, which is 16 × 1023 master clocks between shifts —
 * about 188 Hz of rattle, a full octave below what the three fixed rates reach.
 * A constant rather than a fit, because what the demaker is choosing here is a
 * *colour* from four and not a pitch: the frame carries an index, and the
 * deepest one means "as deep as this chip goes".
 */
const NOISE_DIVIDER = 1023;

/**
 * Map a noise-period index onto the chip's three fixed rates plus its own
 * divisor.
 *
 * Index 0 is the deepest colour, which on this chip means rate 3 — the noise's
 * *own* period register, where an SN76489's rate 3 follows tone channel 2 and
 * costs a voice. Nothing is spent to reach the bottom here, which is the whole
 * reason this part exists.
 */
function noiseRate(index: number): number {
  const clamped = Math.round(index) < 0 ? 0 : Math.round(index);
  if (clamped >= 3) return 0;
  return 3 - clamped;
}
