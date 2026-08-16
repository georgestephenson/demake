/**
 * The Neo Geo Pocket's driver clock, held to the processor's datasheet.
 *
 * `fitRate` is the one place in this project that turns a wanted tempo into a
 * *register value*, and on this console the register is a reload for one of a
 * TMP95C061's 8-bit timers. The rate and the reload are not the same claim —
 * a rate fixes `prescaler × reload`, so a prescaler set that is uniformly wrong
 * still returns the fraction the caller asked for, and only the reload a
 * cartridge programs is wrong. That is exactly how `[2, 8, 32, 128]` survived:
 * every rate this binding ever reported was reachable, and every reload it
 * named a clock the hardware does not have.
 *
 * So what is asserted here is the reload against the datasheet's own
 * arithmetic, rather than the rate against itself. There is no standalone
 * cartridge for this console yet (doc 13 §A5) — when there is, its driver has to
 * agree with these numbers, and this is where the two meet.
 *
 * Source: Toshiba TMP95C061 datasheet §3.8 (8-bit timers) — the up-counter and
 * prescaler sections, Table 3.8 (4), and Table 3.11 (2)'s baud rates at this
 * console's own 6.144 MHz.
 */

import { describe, expect, it } from "vitest";

import { getConsole } from "@demake/core";

import { bindingFor } from "../src/binding/registry.js";

/** The console's crystal, which every division below is of. */
const FC = 6_144_000;

/** The chip's clock and the CPU's system clock: the crystal halved. */
const SYSTEM = FC / 2;

/**
 * The datasheet's four prescaler outputs, as periods of `fc`.
 *
 * φT1 = 8/fc, φT4 = 32/fc, φT16 = 128/fc, φT256 = 2048/fc.
 */
const PHI = { T1: FC / 8, T4: FC / 32, T16: FC / 128, T256: FC / 2048 };

/** What an *upper* timer (1 or 3) may select, which is what a driver rides. */
const UPPER = [PHI.T1, PHI.T16, PHI.T256];

describe("a Neo Geo Pocket driver's clock", () => {
  it("cross-checks the prescaler against the datasheet's own baud table", () => {
    // `Transfer rate = fc / (TREG2 x 8 x 16)` with timer 2 on φT1, tabulated at
    // 6.144 MHz as 48 Kbps for a reload of 1. That is φT1 = fc/8 and can be
    // nothing else, which is the anchor every other division here hangs off.
    expect(FC / (1 * 8 * 16)).toBe(48_000);
    expect(PHI.T1).toBe(FC / 8);
  });

  for (const id of ["ngp", "ngpc"]) {
    describe(id, () => {
      const binding = bindingFor(id);

      it("only ever names a rate one of the processor's own clocks can make", () => {
        // Every timer answer must factor as one of the upper timer's three
        // clocks divided by a reload of 1..256 — which is the whole claim, and
        // the one the old prescaler set failed while still returning the right
        // fraction.
        for (let want = 30; want <= 800; want += 1) {
          const fit = binding.fitRate(want);
          if (fit.source !== "timer") continue;
          const hz = fit.rate.num / fit.rate.den;
          const reload = fit.divisor === 0 ? 256 : (fit.divisor as number);
          expect(reload, `${want} Hz`).toBeGreaterThanOrEqual(1);
          expect(reload, `${want} Hz`).toBeLessThanOrEqual(256);
          const clock = hz * reload;
          expect(
            UPPER.some((phi) => Math.abs(phi - clock) < 1e-6),
            `${want} Hz wants ${clock.toFixed(1)} Hz, which is not φT1, φT16 or φT256`,
          ).toBe(true);
        }
      });

      it("reaches the sound demaker's rate exactly, on the clock that can", () => {
        // 240 Hz is `SFX_RATE_HZ`, and it is φT16 over a reload of 200. The
        // wrong set reached the same rate through a 24 kHz clock and a reload of
        // 100, so asserting the rate alone would pass either way.
        const fit = binding.fitRate(240);
        expect(fit.source).toBe("timer");
        expect(fit.rate.num / fit.rate.den).toBeCloseTo(240, 9);
        expect(fit.divisor).toBe(200);
        expect(PHI.T16 / 200).toBe(240);
      });

      it("takes the frame when the frame is what was asked for", () => {
        // The picture is the candidate every timer has to beat, and it is the
        // only clock a *game* gets — so a rate at the frame must not be talked
        // into a timer that merely matches it.
        const spec = getConsole(id).audio;
        const frame = (spec as { driver: { frameRate: { num: number; den: number } } }).driver
          .frameRate;
        const fit = binding.fitRate(frame.num / frame.den);
        expect(fit.source).toBe("vblank");
      });

      it("states the reload as the period itself, so a full count is zero", () => {
        // The up-counter is cleared to zero on the match, so N input clocks is a
        // reload of N — and 256 does not fit a byte, which is why the binding
        // masks. A driver that wrote 256 as 255 would run one clock fast for
        // ever.
        //
        // φT16 rather than φT256, because a full count of the slow clock is
        // 11.7 Hz and the binding's floor is 30: the widest reload that is
        // actually reachable is the fast clock's.
        const fit = binding.fitRate(PHI.T16 / 256);
        expect(fit.source).toBe("timer");
        expect(fit.divisor).toBe(0);
        expect(fit.rate.num / fit.rate.den).toBeCloseTo(PHI.T16 / 256, 9);
      });
    });
  }

  it("is the same answer on both machines, because it is the same processor", () => {
    for (const want of [60, 120, 240, 300]) {
      const mono = bindingFor("ngp").fitRate(want);
      const colour = bindingFor("ngpc").fitRate(want);
      expect(mono).toEqual(colour);
    }
  });

  it("puts the chip's clock at the crystal halved", () => {
    // One processor state is the oscillator divided by two, and this chip runs
    // at the same clock — which is what makes a reload of `SYSTEM / phi` mean
    // the same thing to the binding and to `@demake/ngp`.
    expect(bindingFor("ngpc").fitRate(240).rate.num).toBe(SYSTEM);
  });
});
