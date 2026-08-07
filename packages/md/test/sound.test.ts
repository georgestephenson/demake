/**
 * What the sound hardware answers when nothing is listening.
 *
 * One property, and it is the one thing about this console's audio that no
 * register diff can reach: **a timer is not audio.** Every other chip in the set
 * is write-only, so a model that only advanced while a sample sink was attached
 * was indistinguishable from one that always did — the tests never noticed, and
 * neither did a game, because a game's driver rides the picture's interrupt.
 *
 * A standalone audio cartridge does not (`@demake/audio`'s `rom/md.ts`). Its
 * clock is the YM2612's timer A, polled from a main loop that does nothing else,
 * and the status byte it polls is *bus-visible state* rather than a rendering.
 * A console that stopped the chip whenever the speakers were unplugged would
 * leave such a cartridge spinning for ever on a flag that could never be set.
 */

import { describe, expect, it } from "vitest";

import { Md } from "../src/machine.js";

/** A cartridge that does nothing, so the machine has something valid to boot. */
function blankRom(): Uint8Array {
  const rom = new Uint8Array(0x20000);
  // Stack, then reset — the only two longs the hardware reads unasked. The entry
  // is `bra *`, which parks the CPU without touching anything.
  rom.set([0x00, 0xff, 0xff, 0xfe], 0x00);
  rom.set([0x00, 0x00, 0x02, 0x00], 0x04);
  rom.set([0x60, 0xfe], 0x200); // bra.s *
  return rom;
}

describe("the FM chip runs whether or not anything is listening", () => {
  it("raises timer A's overflow flag with no sample sink attached", () => {
    const machine = new Md(blankRom());
    expect(machine.ymSink).toBeUndefined();

    // A short period, so the overflow arrives quickly: the counter runs at the
    // chip's sample rate and reloads from 1024 minus what `$24`/`$25` hold
    // between them, so `$3F0` is sixteen samples.
    machine.write8(0xa04000, 0x24);
    machine.write8(0xa04001, 0xfc);
    machine.write8(0xa04000, 0x25);
    machine.write8(0xa04001, 0x00);
    expect(machine.read8(0xa04000) & 0x01).toBe(0);

    // Run A, and enable the flag it sets.
    machine.write8(0xa04000, 0x27);
    machine.write8(0xa04001, 0x05);
    for (let step = 0; step < 20_000 && (machine.read8(0xa04000) & 0x01) === 0; step += 1) {
      machine.stepInstruction();
    }
    expect(machine.read8(0xa04000) & 0x01).toBe(1);
  });

  it("clears the flag on request and sets it again, without reloading the counter", () => {
    // The acknowledge a polled driver performs: the reset bit with the run bit
    // still set. The hardware only reloads the counter when the run bit goes
    // from clear to set, which is what keeps the poll's own latency from
    // accumulating into the tempo — so the second overflow has to arrive a full
    // period after the first rather than a period after the acknowledge.
    const machine = new Md(blankRom());
    machine.write8(0xa04000, 0x24);
    machine.write8(0xa04001, 0xfc);
    machine.write8(0xa04000, 0x25);
    machine.write8(0xa04001, 0x00);
    machine.write8(0xa04000, 0x27);
    machine.write8(0xa04001, 0x05);

    const until = (): number => {
      let cycles = 0;
      for (let step = 0; step < 20_000 && (machine.read8(0xa04000) & 0x01) === 0; step += 1) {
        cycles += machine.stepInstruction();
      }
      expect(machine.read8(0xa04000) & 0x01).toBe(1);
      return cycles;
    };

    until();
    machine.write8(0xa04000, 0x27);
    machine.write8(0xa04001, 0x15);
    expect(machine.read8(0xa04000) & 0x01).toBe(0);
    const second = until();
    // Sixteen samples, and on this console one CPU cycle is one chip clock —
    // both come off the master clock over seven — so a sample is 144 of them.
    // Within one instruction, because the poll only looks between them.
    expect(Math.abs(second - 16 * 144)).toBeLessThan(60);
  });
});
