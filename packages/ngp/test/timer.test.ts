/**
 * The TLCS-900/H's 8-bit interval timers, held to the datasheet.
 *
 * This block exists for one caller — the standalone audio cartridge, whose
 * clock the picture cannot express — and that caller's own proof is a register
 * diff, which cannot tell a timer running at the wrong rate from a schedule
 * fitted to the wrong rate. So the arithmetic is pinned here, against the
 * datasheet's numbers rather than against a driver that agrees with it.
 *
 * Four of these cases are the ways a cartridge can programme this block and get
 * silence or a wrong tempo with every write correct, which is why each is
 * separate: the prescaler left stopped, a reload of zero read as "every clock"
 * rather than 256, a clock selection that is not a division at all, and a
 * priority of seven read as "most urgent" rather than "off".
 *
 * Source: Toshiba TMP95C061 datasheet §3.8 and the §3.3 interrupt-enable table.
 */

import { describe, expect, it } from "vitest";

import {
  NGP_INTET01,
  NGP_T01MOD,
  NGP_T01M,
  NGP_T01M_SHIFT,
  NGP_T0CLK,
  NGP_T0CLK_SHIFT,
  NGP_T1CLK,
  NGP_T1CLK_SHIFT,
  NGP_TREG0,
  NGP_TREG1,
  NGP_SOUND_RIGHT,
  NGP_TRUN,
  NGP_TRUN_BITS,
} from "@demake/core";

import { Ngp } from "../src/machine.js";
import { Timers } from "../src/timer.js";

/** The console's crystal, and the system clock the timers count. */
const SYSTEM = 6_144_000 / 2;

/** Programme the pair for two 8-bit timers with the given clock selections. */
function mode(lower: number, upper: number): number {
  return (
    (NGP_T01M.two8Bit << NGP_T01M_SHIFT) | (lower << NGP_T0CLK_SHIFT) | (upper << NGP_T1CLK_SHIFT)
  );
}

/** Run `cycles` of system clock in small steps, counting the fires. */
function run(timers: Timers, cycles: number, step = 16): number[] {
  const fired: number[] = [];
  for (let spent = 0; spent < cycles; spent += step) {
    const fire = timers.step(step);
    if (fire) fired.push(fire.timer);
  }
  return fired;
}

/** A block programmed the way a driver would: timer 1 on phi-T256. */
function armed(reload: number): Timers {
  const timers = new Timers();
  timers.write(NGP_T01MOD, mode(NGP_T0CLK.t1, NGP_T1CLK.t256));
  timers.write(NGP_TREG1, reload);
  timers.write(NGP_INTET01, 3 << 4); // priority 3 on the upper timer
  timers.write(NGP_TRUN, (1 << NGP_TRUN_BITS.prescaler) | (1 << NGP_TRUN_BITS.timer1));
  return timers;
}

describe("the 8-bit interval timers", () => {
  it("counts phi-T256 at the system clock over 1024", () => {
    // 3000 Hz, and a reload of 25 is the 120 Hz a driver wants. Asserted as a
    // rate rather than as a count, because the rate is what a schedule declares.
    const timers = armed(25);
    const seconds = 0.5;
    const fired = run(timers, Math.round(SYSTEM * seconds));
    expect(fired.every((index) => index === 1)).toBe(true);
    expect(fired.length).toBeCloseTo(120 * seconds, 0);
  });

  it("gives each clock selection the datasheet's own division", () => {
    for (const [select, divisor] of [
      [NGP_T1CLK.t1, 4],
      [NGP_T1CLK.t16, 64],
      [NGP_T1CLK.t256, 1024],
    ] as const) {
      const timers = new Timers();
      timers.write(NGP_T01MOD, mode(NGP_T0CLK.t1, select));
      timers.write(NGP_TREG1, 10);
      timers.write(NGP_INTET01, 1 << 4);
      timers.write(NGP_TRUN, (1 << NGP_TRUN_BITS.prescaler) | (1 << NGP_TRUN_BITS.timer1));
      // One period is divisor x reload system clocks, exactly.
      const fired = run(timers, divisor * 10 * 4, 8);
      expect(fired.length, `select ${select}`).toBe(4);
    }
  });

  it("counts nothing while the shared prescaler is stopped", () => {
    // The trap: a cartridge that sets its own run bit and forgets bit 7 has a
    // perfect register page and a timer that never fires.
    const timers = new Timers();
    timers.write(NGP_T01MOD, mode(NGP_T0CLK.t1, NGP_T1CLK.t256));
    timers.write(NGP_TREG1, 25);
    timers.write(NGP_INTET01, 3 << 4);
    timers.write(NGP_TRUN, 1 << NGP_TRUN_BITS.timer1);
    expect(run(timers, SYSTEM)).toEqual([]);
  });

  it("reads a reload of zero as a full 256, not as every clock", () => {
    const timers = armed(0);
    // 3000 / 256 is 11.72 Hz, so half a second is five or six fires — not the
    // thousands a counter comparing against literal zero would produce.
    const fired = run(timers, Math.round(SYSTEM * 0.5));
    expect(fired.length).toBeGreaterThan(3);
    expect(fired.length).toBeLessThan(9);
  });

  it("refuses a selection that is not a division", () => {
    // Selection 0 is the external pin below and the partner's comparator output
    // above. Neither is a rate, and a model that treated the field as an index
    // into a table starting at 4 would run the timer four times too fast.
    const timers = new Timers();
    timers.write(NGP_T01MOD, mode(NGP_T0CLK.external, NGP_T1CLK.cascade));
    timers.write(NGP_TREG0, 10);
    timers.write(NGP_TREG1, 10);
    timers.write(NGP_INTET01, (3 << 4) | 3);
    timers.write(NGP_TRUN, 0xff);
    expect(run(timers, SYSTEM)).toEqual([]);
  });

  it("treats priority seven as off, exactly as priority zero is", () => {
    for (const priority of [0, 7]) {
      const timers = new Timers();
      timers.write(NGP_T01MOD, mode(NGP_T0CLK.t1, NGP_T1CLK.t256));
      timers.write(NGP_TREG1, 25);
      timers.write(NGP_INTET01, priority << 4);
      timers.write(NGP_TRUN, (1 << NGP_TRUN_BITS.prescaler) | (1 << NGP_TRUN_BITS.timer1));
      expect(run(timers, SYSTEM), `priority ${priority}`).toEqual([]);
    }
  });

  it("accepts every priority the field says it should", () => {
    for (let priority = 1; priority <= 6; priority += 1) {
      const timers = new Timers();
      timers.write(NGP_T01MOD, mode(NGP_T0CLK.t1, NGP_T1CLK.t256));
      timers.write(NGP_TREG1, 25);
      timers.write(NGP_INTET01, priority << 4);
      timers.write(NGP_TRUN, (1 << NGP_TRUN_BITS.prescaler) | (1 << NGP_TRUN_BITS.timer1));
      expect(run(timers, SYSTEM / 60).length, `priority ${priority}`).toBeGreaterThan(0);
    }
  });

  it("clears the counter when a run bit goes down rather than pausing it", () => {
    const timers = armed(25);
    // Most of a period, then stopped and restarted: the part already counted is
    // discarded, so the next fire is a whole period away rather than moments.
    timers.step(1024 * 20);
    timers.write(NGP_TRUN, 1 << NGP_TRUN_BITS.prescaler);
    timers.write(NGP_TRUN, (1 << NGP_TRUN_BITS.prescaler) | (1 << NGP_TRUN_BITS.timer1));
    expect(run(timers, 1024 * 20, 256)).toEqual([]);
    expect(run(timers, 1024 * 6, 256).length).toBe(1);
  });

  it("names a mode it does not implement rather than interval-timing anyway", () => {
    const timers = new Timers();
    timers.write(NGP_T01MOD, NGP_T01M.cascade16Bit << NGP_T01M_SHIFT);
    expect(timers.unsupported).toMatch(/timer mode/);
  });

  it("counts a second timer without arming its interrupt", () => {
    // Both running, only the upper one's priority accepting. That is the shape
    // a cartridge would actually have if it ever wanted two, and it is the one
    // this model serves: counting is per timer and only the arming is limited.
    const timers = new Timers();
    timers.write(NGP_T01MOD, mode(NGP_T0CLK.t16, NGP_T1CLK.t256));
    timers.write(NGP_TREG0, 100);
    timers.write(NGP_TREG1, 25);
    timers.write(NGP_INTET01, 3 << 4); // timer 1 armed, timer 0 at priority 0
    timers.write(
      NGP_TRUN,
      (1 << NGP_TRUN_BITS.prescaler) | (1 << NGP_TRUN_BITS.timer0) | (1 << NGP_TRUN_BITS.timer1),
    );
    const fired = run(timers, SYSTEM / 10, 8);
    expect(fired.every((index) => index === 1)).toBe(true);
    expect(fired.length).toBeCloseTo(12, -1);
    expect(timers.unsupported).toBeUndefined();
  });

  it("refuses two armed timers rather than losing one of them", () => {
    // 480 Hz and 120 Hz alias perfectly — every fourth match of the fast timer
    // lands on a match of the slow one — so a model that returned the lower
    // index and forgot the other would drop *every* slow tick and report a
    // driver running at no rate at all. It says so instead.
    const timers = new Timers();
    timers.write(NGP_T01MOD, mode(NGP_T0CLK.t16, NGP_T1CLK.t256));
    timers.write(NGP_TREG0, 100);
    timers.write(NGP_TREG1, 25);
    timers.write(NGP_INTET01, (3 << 4) | 3);
    timers.write(
      NGP_TRUN,
      (1 << NGP_TRUN_BITS.prescaler) | (1 << NGP_TRUN_BITS.timer0) | (1 << NGP_TRUN_BITS.timer1),
    );
    run(timers, SYSTEM / 10, 8);
    expect(timers.unsupported).toMatch(/both raised/);
  });
});

describe("the block is described and deliberately not wired in", () => {
  it("collides with the sound chip's own port, which is why", () => {
    // Two cited sources, one byte. Toshiba's datasheet puts TRUN at I/O $20 and
    // MAME's Neo Geo Pocket driver puts the T6W28's right-hand write port
    // there. This is the assertion that keeps the conflict from being forgotten
    // and quietly re-resolved in favour of whichever description somebody read
    // most recently — if it ever stops holding, one of the two has been fixed
    // and the standalone cartridge is unblocked (doc 13 §A5).
    expect(Timers.owns(NGP_SOUND_RIGHT)).toBe(true);
  });

  it("does not take the register page away from the chip", () => {
    // The failure this guards is not subtle once seen and is invisible before:
    // a machine that routed $20 to the timers swallows every write to the
    // right-hand port, so a cartridge boots, unlocks the chip, programmes a
    // clock and plays silence with a perfect register page.
    const machine = new Ngp();
    const seen: number[] = [];
    machine.soundTap = (reg) => seen.push(reg);
    machine.write(0x38, 0x55);
    machine.write(0x39, 0xaa);
    machine.write(NGP_SOUND_RIGHT, 0x9f);
    expect(seen.length).toBe(1);
  });
});
