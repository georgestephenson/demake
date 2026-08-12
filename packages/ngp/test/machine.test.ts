/**
 * The machine around the processor: the clocks, and the way to the sound chip.
 *
 * Two things here, and both are ones a core can get wrong while every trace and
 * every register diff still passes.
 *
 *   - **A processor state is not a master cycle.** This CPU's timings are in
 *     states of the crystal *halved*, and the display controller counts the
 *     crystal — so a machine that fed one to the other would run at half the
 *     frame rate with nothing to show for it, because a trace is per tick and a
 *     tick is per frame either way. The audio is what makes it visible: a chip
 *     handed the wrong number of clocks renders at the wrong speed.
 *   - **The sound chip belongs to the Z80 until it is asked for.** Two bytes
 *     hand it to the main CPU, and until they are written a write to either port
 *     does nothing. A model without the gate would let a cartridge that never
 *     wrote them appear to work.
 */

import { describe, expect, it } from "vitest";

import {
  NGP_RAS_H,
  NGP_RAS_V,
  NGP_SOUND_ENABLE,
  NGP_SOUND_ENABLE_HIGH,
  NGP_SOUND_ENABLE_HIGH_VALUE,
  NGP_SOUND_ENABLE_VALUE,
  NGP_SOUND_LEFT,
  NGP_SOUND_RIGHT,
} from "@demake/core";
import { T6W28_LEFT, T6W28_RIGHT } from "@demake/chip";

import { NGP_STATUS } from "@demake/core";

import { CYCLES_PER_LINE, LINES_PER_FRAME, SCREEN_HEIGHT, SCREEN_WIDTH } from "../src/display.js";
import { Ngp } from "../src/machine.js";

/** The console's crystal, which the display counts. */
const CRYSTAL_HZ = 6_144_000;

describe("the machine's clocks", () => {
  it("draws a frame in the time the crystal says, not the processor's", () => {
    // 515 master cycles a line and 199 lines, which is 59.95 Hz — and the
    // processor's own unit is half of that, so a machine that handed the display
    // its states would draw thirty frames a second on hardware that draws sixty.
    const perFrame = CYCLES_PER_LINE * LINES_PER_FRAME;
    expect(CRYSTAL_HZ / perFrame).toBeCloseTo(59.95, 1);

    const machine = new Ngp();
    // `halt` is the one instruction whose cost this core states outright, so it
    // is what lets a frame be counted in *states* without decoding anything.
    machine.ram[0] = 0x05; // halt
    machine.cpu.reset(0x004000, 0x006c00);
    // From one vertical blank to the next, because that is where this machine
    // counts a frame — the first stretch is only the visible lines.
    while (machine.frames === 0) machine.step();
    let states = 0;
    while (machine.frames === 1) states += machine.step();
    // Half the master cycles, give or take the instruction that crossed the
    // boundary — a `halt` is four states, and the frame is not a whole number of
    // them because 515 lines of an odd length is not.
    expect(states).toBeGreaterThan(perFrame / 2 - 4);
    expect(states).toBeLessThan(perFrame / 2 + 4);
  });
});

describe("the beam a cartridge can read", () => {
  /** A machine parked on `halt`, so stepping it only advances the clock. */
  function halted(): Ngp {
    const machine = new Ngp();
    machine.ram[0] = 0x05; // halt
    machine.cpu.reset(0x004000, 0x006c00);
    return machine;
  }

  it("answers the scanline counter rather than the memory behind it", () => {
    // These three addresses are the *controller* answering, not memory being
    // read back — and until they were, a cartridge polling the beam read
    // whatever it had last written there, which is a runtime waiting for a frame
    // that never comes. `@demake/wsc`'s readable timer one console along.
    const machine = halted();
    machine.write(NGP_RAS_V, 0xaa);
    expect(machine.read(NGP_RAS_V)).toBe(0);

    // A whole frame, sampled every instruction. A `halt` is four states and a
    // line is 515 master cycles, so a line is about sixty-four of them — which
    // is why this is counted in frames rather than in a round number of steps.
    const seen = new Set<number>();
    while (machine.frames < 1) {
      machine.step();
      seen.add(machine.read(NGP_RAS_V));
    }
    while (machine.frames < 2) {
      machine.step();
      seen.add(machine.read(NGP_RAS_V));
    }
    // Every line the controller has, and none it does not.
    expect(seen.size).toBeGreaterThan(SCREEN_HEIGHT);
    expect(Math.max(...seen)).toBe(LINES_PER_FRAME - 1);
  });

  it("says when the display is blanking, which is how a cartridge waits", () => {
    const machine = halted();
    let sawVisible = false;
    let sawBlank = false;
    while (machine.frames < 2) {
      machine.step();
      const blanking = (machine.read(NGP_STATUS) & 0x40) !== 0;
      // The flag and the counter are one answer: a status bit that disagreed
      // with the line it is about would be a flag nobody could act on.
      expect(blanking).toBe(machine.read(NGP_RAS_V) >= SCREEN_HEIGHT);
      if (blanking) sawBlank = true;
      else sawVisible = true;
    }
    expect(sawVisible && sawBlank).toBe(true);
  });

  it("puts the horizontal beam inside the screen", () => {
    const machine = halted();
    while (machine.frames < 1) {
      machine.step();
      const x = machine.read(NGP_RAS_H);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(SCREEN_WIDTH);
    }
  });
});

describe("the way to the sound chip", () => {
  /** Every write the chip received, as (port, value). */
  function taps(machine: Ngp): [number, number][] {
    const seen: [number, number][] = [];
    machine.soundTap = (reg, value) => seen.push([reg, value]);
    return seen;
  }

  function unlock(machine: Ngp): void {
    machine.write(NGP_SOUND_ENABLE, NGP_SOUND_ENABLE_VALUE);
    machine.write(NGP_SOUND_ENABLE_HIGH, NGP_SOUND_ENABLE_HIGH_VALUE);
  }

  it("ignores the chip until the main CPU has been handed it", () => {
    const machine = new Ngp();
    const seen = taps(machine);
    machine.write(NGP_SOUND_LEFT, 0x9f);
    expect(seen).toEqual([]);
    unlock(machine);
    machine.write(NGP_SOUND_LEFT, 0x9f);
    expect(seen).toEqual([[T6W28_LEFT, 0x9f]]);
  });

  it("reports the port a write went to, because that is what a register is here", () => {
    const machine = new Ngp();
    unlock(machine);
    const seen = taps(machine);
    machine.write(NGP_SOUND_RIGHT, 0xe4);
    machine.write(NGP_SOUND_LEFT, 0x81);
    // A tap that reported only the byte could not tell a left-hand attenuator
    // from a right-hand one, and this chip's two ports carry different
    // registers — so the port is the whole of what makes a diff meaningful.
    expect(seen).toEqual([
      [T6W28_RIGHT, 0xe4],
      [T6W28_LEFT, 0x81],
    ]);
  });

  it("lets the write through rather than swallowing it", () => {
    // The tap observes; the chip still receives. An oracle that intercepted
    // would be testing itself.
    const machine = new Ngp();
    unlock(machine);
    let taken = 0;
    machine.soundTap = () => (taken += 1);
    machine.write(NGP_SOUND_LEFT, 0x80 | (0 << 5) | 0x0e);
    machine.write(NGP_SOUND_LEFT, 0x0d);
    machine.write(NGP_SOUND_LEFT, 0x90);
    expect(taken).toBe(3);
    // Rendered through the chip the tone is audible, which it would not be if
    // the tap had eaten the writes.
    let peak = 0;
    const sink = {
      clocksUntilSampleBoundary: () => 64,
      add: (left: number) => {
        peak = Math.max(peak, Math.abs(left));
      },
    };
    machine.sound.run(20000, sink);
    expect(peak).toBeGreaterThan(0);
  });
});
