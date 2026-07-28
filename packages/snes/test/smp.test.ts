import { A, Asm700, X, Y, YA, spcAbs, spcDp, spcImm, spcIndXInc } from "@demake/core";
import { describe, expect, it } from "vitest";

import { BOOT_ROM, BOOT_ROM_BASE, SPC_CLOCK_HZ, Smp } from "../src/index.js";

/** Master cycles per SPC700 cycle, near enough for a test's patience. */
const MASTER_PER_SPC = 21;

function pump(smp: Smp, spcCycles: number): void {
  smp.run(spcCycles * MASTER_PER_SPC);
}

/**
 * The main CPU's half of the upload handshake.
 *
 * Written here as well as in the 65816 backend on purpose: this is the *spec*
 * side of the protocol, so a boot ROM that only worked against our own uploader
 * would pass one of the two and fail the other.
 */
function upload(smp: Smp, address: number, data: Uint8Array, entry: number): void {
  const settle = (): void => pump(smp, 200);
  let guard = 0;
  const wait = (want: number): void => {
    while (smp.readPort(0) !== want) {
      settle();
      if ((guard += 1) > 20000) throw new Error("smp: the boot ROM never answered");
    }
  };

  while (smp.readPort(0) !== 0xaa || smp.readPort(1) !== 0xbb) settle();
  smp.writePort(2, address & 0xff);
  smp.writePort(3, (address >> 8) & 0xff);
  smp.writePort(1, 0x01);
  smp.writePort(0, 0xcc);
  wait(0xcc);

  let counter = 0;
  for (const byte of data) {
    smp.writePort(1, byte);
    smp.writePort(0, counter);
    wait(counter);
    counter = (counter + 1) & 0xff;
  }

  smp.writePort(2, entry & 0xff);
  smp.writePort(3, (entry >> 8) & 0xff);
  smp.writePort(1, 0x00);
  // Two past the last byte's counter: one is "the sender is still working".
  smp.writePort(0, (counter + 1) & 0xff);
  settle();
}

describe("Smp", () => {
  it("has a boot ROM that fits its window and starts at the reset vector", () => {
    expect(BOOT_ROM).toHaveLength(0x10000 - BOOT_ROM_BASE);
    expect(BOOT_ROM[0x3e]).toBe(BOOT_ROM_BASE & 0xff);
    expect(BOOT_ROM[0x3f]).toBe(BOOT_ROM_BASE >> 8);
  });

  it("greets the main CPU with $AA/$BB", () => {
    const smp = new Smp();
    // The greeting comes after the boot ROM has cleared 239 bytes of RAM, which
    // is about 2400 cycles — a real cartridge polls for it rather than counting.
    pump(smp, 5000);
    expect(smp.readPort(0)).toBe(0xaa);
    expect(smp.readPort(1)).toBe(0xbb);
  });

  it("takes an upload and runs it", () => {
    const smp = new Smp();
    const writes: [number, number][] = [];
    smp.dspTap = (reg, value) => writes.push([reg, value]);

    const asm = new Asm700(0x0400);
    asm.mov(spcDp(0xf2), spcImm(0x0c)); // DSPADDR = MVOL(L)
    asm.mov(spcDp(0xf3), spcImm(0x7f)); // DSPDATA
    asm.mov(spcDp(0xf4), spcImm(0x42)); // "I am running"
    asm.label("Halt");
    asm.bra("Halt");
    upload(smp, 0x0400, asm.assemble(), 0x0400);

    pump(smp, 200);
    expect(smp.readPort(0)).toBe(0x42);
    expect(writes).toEqual([[0x0c, 0x7f]]);
    expect(smp.dsp.read(0x0c)).toBe(0x7f);
  });

  it("uploads the bytes to the address it was given", () => {
    const smp = new Smp();
    const data = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55]);
    // The entry points at a halt loop we upload as part of the same block.
    const asm = new Asm700(0x0500);
    asm.label("Halt");
    asm.bra("Halt");
    const image = new Uint8Array(5 + asm.length);
    image.set(data, 0);
    image.set(asm.assemble(), 5);
    upload(smp, 0x0500, image, 0x0505);
    expect([...smp.ram.slice(0x0500, 0x0505)]).toEqual([...data]);
  });

  it("counts a timer at the rate its divisor asks for", () => {
    const smp = new Smp();
    const asm = new Asm700(0x0400);
    asm.mov(spcDp(0xfa), spcImm(64)); // 8000 / 64 = 125 Hz
    asm.mov(spcDp(0xf1), spcImm(0x01)); // timer 0 on
    asm.label("Loop");
    asm.mov(A, spcDp(0xfd));
    asm.beq("Loop");
    asm.inc(spcDp(0x10));
    asm.bra("Loop");
    upload(smp, 0x0400, asm.assemble(), 0x0400);

    pump(smp, SPC_CLOCK_HZ / 10); // a tenth of a second
    // 125 Hz for a tenth of a second is twelve or thirteen ticks, and the loop
    // reads far faster than the timer produces them.
    expect(smp.ram[0x10]).toBeGreaterThanOrEqual(11);
    expect(smp.ram[0x10]).toBeLessThanOrEqual(14);
  });

  it("runs the arithmetic a driver is written in", () => {
    const smp = new Smp();
    const asm = new Asm700(0x0400);
    // A block copy through `(X)+`, then a sixteen-bit add on the pointer, which
    // between them are most of what a schedule player does.
    asm.mov(X, spcImm(0x00));
    asm.mov(Y, spcImm(0x04));
    asm.mov(A, spcImm(0x9c));
    asm.mov(spcDp(0x20), A);
    asm.mov(A, spcImm(0x11));
    asm.mov(spcIndXInc, A);
    asm.mov(A, spcImm(0x22));
    asm.mov(spcIndXInc, A);
    asm.mov(A, spcImm(0x40));
    asm.mov(spcDp(0x30), A);
    asm.mov(A, spcImm(0x01));
    asm.mov(spcDp(0x31), A);
    asm.movw(YA, spcDp(0x30));
    asm.addw(YA, spcDp(0x30));
    asm.movw(spcDp(0x32), YA);
    asm.label("Halt");
    asm.bra("Halt");
    upload(smp, 0x0400, asm.assemble(), 0x0400);
    pump(smp, 500);

    expect(smp.ram[0x00]).toBe(0x11);
    expect(smp.ram[0x01]).toBe(0x22);
    expect(smp.ram[0x20]).toBe(0x9c);
    // $0140 + $0140 = $0280, little-endian at $32.
    expect(smp.ram[0x32]).toBe(0x80);
    expect(smp.ram[0x33]).toBe(0x02);
  });

  it("keeps the boot ROM readable and the RAM under it writable", () => {
    const smp = new Smp();
    const asm = new Asm700(0x0400);
    asm.mov(A, spcImm(0x5a));
    asm.mov(spcAbs(BOOT_ROM_BASE), A); // lands in the RAM under the ROM
    asm.mov(A, spcAbs(BOOT_ROM_BASE)); // ...but a read still sees the ROM
    asm.mov(spcDp(0xf4), A);
    asm.mov(spcDp(0xf1), spcImm(0x00)); // unmap it
    asm.mov(A, spcAbs(BOOT_ROM_BASE));
    asm.mov(spcDp(0xf5), A);
    asm.label("Halt");
    asm.bra("Halt");
    upload(smp, 0x0400, asm.assemble(), 0x0400);
    pump(smp, 400);
    expect(smp.readPort(0)).toBe(BOOT_ROM[0]);
    expect(smp.readPort(1)).toBe(0x5a);
  });
});
