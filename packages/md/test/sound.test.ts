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
 *
 * The condition `machine.ts` actually applies is narrower than "always", and
 * deliberately: a sink **or** a running timer, which is the full list of ways
 * this chip's advancing can be seen. The other half of that — a chip with
 * neither, which is every demade *game*, doing nothing at all — is not pinned
 * here and cannot be, because it is unobservable through the bus by
 * construction. That is exactly what makes skipping it safe, and skipping it is
 * worth a fifth of the Mega Drive audio battery's time budget.
 */

import { describe, expect, it } from "vitest";

import { Md } from "../src/machine.js";

/**
 * A machine whose sound hardware has been released from reset.
 *
 * `$A11200` is the Z80's reset line *and* the YM2612's, and a console powers up
 * with it held — so a program that never writes it has an FM chip that discards
 * everything (`machine.ts` §writeYm). Every case below is about the chip rather
 * than about the board, so they start where a cartridge's own boot leaves them.
 */
function withSound(): Md {
  const machine = new Md(blankRom());
  machine.write16(0xa11100, 0x0100);
  machine.write16(0xa11200, 0x0100);
  return machine;
}

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

describe("the FM chip runs when anything can observe it", () => {
  it("raises timer A's overflow flag with no sample sink attached", () => {
    const machine = withSound();
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
    const machine = withSound();
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

describe("the sound hardware's reset line", () => {
  it("holds the FM chip until $A11200 releases it", () => {
    // One wire to two chips: `$A11200` resets the Z80 *and* the YM2612, and the
    // console powers up with it asserted. This core models no Z80 at all, so
    // before it modelled the line a cartridge that never wrote the register had
    // six four-operator voices answering here and none on the board — a register
    // diff that passed against a chip that was not listening (doc 16 §The proof,
    // and AGENTS.md §Gotchas on a description that is wrong and consistent).
    const machine = new Md(blankRom());
    const seen: number[] = [];
    machine.ymTap = (port) => seen.push(port);

    // Held: a whole timer programming, discarded.
    machine.write8(0xa04000, 0x24);
    machine.write8(0xa04001, 0xfc);
    machine.write8(0xa04000, 0x27);
    machine.write8(0xa04001, 0x05);
    expect(seen).toEqual([]);
    // And nothing reaches the chip, which the flag that timer would set says.
    for (let step = 0; step < 20_000; step += 1) machine.stepInstruction();
    expect(machine.read8(0xa04000) & 0x01).toBe(0);

    // Released, and the same writes arrive.
    machine.write16(0xa11200, 0x0100);
    machine.write8(0xa04000, 0x24);
    machine.write8(0xa04001, 0xfc);
    expect(seen).toEqual([0, 1]);
  });

  it("takes the line from either width, in the half the bus puts it", () => {
    // A word write carries it on bit 8 and a byte write to the same address puts
    // its data on the bus's high half, so the byte's bit 0 is the same line. A
    // core that read bit 0 of a word would leave the chip held for a boot that
    // is correct on hardware.
    const word = new Md(blankRom());
    word.write16(0xa11200, 0x0100);
    const byte = new Md(blankRom());
    byte.write8(0xa11200, 0x01);
    for (const machine of [word, byte]) {
      const seen: number[] = [];
      machine.ymTap = (port) => seen.push(port);
      machine.write8(0xa04000, 0x22);
      expect(seen).toEqual([0]);
    }
    // And asserting it again holds the chip once more.
    word.write16(0xa11200, 0x0000);
    const after: number[] = [];
    word.ymTap = (port) => after.push(port);
    word.write8(0xa04000, 0x22);
    expect(after).toEqual([]);
  });
});
