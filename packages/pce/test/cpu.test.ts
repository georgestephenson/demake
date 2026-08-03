/**
 * The HuC6280, driven by `core`'s own assembler.
 *
 * The pairing is the point, and it is the same one `packages/sms/test/cpu.test.ts`
 * makes: an encoder and a decoder that agreed with each other and not with the
 * hardware would still pass a test written against either alone, so the published
 * opcode bytes are pinned in `core/test/huc6280.test.ts` and *behaviour* is
 * pinned here, over programs the assembler emitted.
 *
 * What is checked is what a 6502 test would not: the zero page that is not page
 * zero, the mapper that decides what an address means, and the block transfer
 * that is a loop the CPU runs for you.
 */

import { Asm6280, abs, imm, indY, zp } from "@demake/core";
import { describe, expect, it } from "vitest";

import { Pce } from "../src/machine.js";
import { STACK } from "../src/cpu.js";

/** Build a one-bank cartridge whose reset vector runs `body`, and boot it. */
function machine(body: (asm: Asm6280) => void): Pce {
  const asm = new Asm6280(0xe000);
  asm.label("Reset");
  // Work RAM at `$2000` is what every program here needs before it can use the
  // zero page at all, which is itself the first thing worth demonstrating.
  asm.lda(imm(0xf8));
  asm.tam(Asm6280.mprBit(1));
  asm.ldx(imm(0xff));
  asm.txs();
  body(asm);
  asm.label("Done");
  asm.bra("Done");
  const code = asm.assemble();
  const bank = new Uint8Array(0x2000).fill(0xff);
  bank.set(code, 0);
  // The reset vector, at the top of bank 0.
  const reset = asm.addressOf("Reset");
  bank[0x1ffe] = reset & 0xff;
  bank[0x1fff] = (reset >> 8) & 0xff;
  return new Pce(bank);
}

/** Run until the program reaches its parking loop, then hand it back. */
function run(pce: Pce, steps = 20000): Pce {
  for (let index = 0; index < steps; index += 1) {
    const before = pce.cpu.pc;
    pce.stepInstruction();
    // The parking loop is a `bra` to itself: the program counter stops moving.
    if (pce.cpu.pc === before) return pce;
  }
  throw new Error("pce: the test program never parked");
}

describe("the HuC6280", () => {
  it("puts its zero page at $2000, not at $0000", () => {
    const pce = run(
      machine((asm) => {
        asm.lda(imm(0x5a));
        asm.sta(zp(0x40));
      }),
    );
    // Work RAM offset `$40`, reached as `zp($40)`.
    expect(pce.ram[0x40]).toBe(0x5a);
    // And as an absolute address, which is the same byte.
    expect(pce.cpu.read(0x2040)).toBe(0x5a);
  });

  it("puts its stack in the page above that", () => {
    const pce = run(
      machine((asm) => {
        asm.lda(imm(0x99));
        asm.pha();
      }),
    );
    // `sp` starts at `$FF` and the push lands at `$21FF`.
    expect(pce.cpu.read(STACK + 0xff)).toBe(0x99);
    expect(pce.cpu.sp).toBe(0xfe);
  });

  it("dereferences a zero-page pointer through the same window", () => {
    const pce = run(
      machine((asm) => {
        // A pointer at `$2010` aiming at `$2200`, written a byte at a time.
        asm.lda(imm(0x00));
        asm.sta(zp(0x10));
        asm.lda(imm(0x22));
        asm.sta(zp(0x11));
        asm.ldy(imm(3));
        asm.lda(imm(0x7e));
        asm.sta(indY(0x10));
      }),
    );
    expect(pce.ram[0x203]).toBe(0x7e);
  });

  it("maps a cartridge bank wherever `tam` puts it", () => {
    const asm = new Asm6280(0xe000);
    asm.label("Reset");
    asm.lda(imm(0xf8));
    asm.tam(Asm6280.mprBit(1));
    asm.ldx(imm(0xff));
    asm.txs();
    // Bank 1 at `$4000`, then read its first byte.
    asm.lda(imm(1));
    asm.tam(Asm6280.mprBit(2));
    asm.lda(abs(0x4000));
    asm.sta(zp(0x00));
    asm.label("Done");
    asm.bra("Done");
    const code = asm.assemble();
    const rom = new Uint8Array(0x4000).fill(0xff);
    rom.set(code, 0);
    const reset = asm.addressOf("Reset");
    rom[0x1ffe] = reset & 0xff;
    rom[0x1fff] = (reset >> 8) & 0xff;
    rom[0x2000] = 0xc3; // the first byte of bank 1
    expect(run(new Pce(rom)).ram[0]).toBe(0xc3);
  });

  it("runs a block transfer as the loop it is, and destroys three registers", () => {
    const asm = new Asm6280(0xe000);
    asm.label("Reset");
    asm.lda(imm(0xf8));
    asm.tam(Asm6280.mprBit(1));
    asm.ldx(imm(0xff));
    asm.txs();
    asm.ldy(imm(0x77));
    asm.tii("Source", 0x2200, 4);
    asm.label("Done");
    asm.bra("Done");
    asm.label("Source");
    asm.db(1, 2, 3, 4);
    const code = asm.assemble();
    const bank = new Uint8Array(0x2000).fill(0xff);
    bank.set(code, 0);
    const reset = asm.addressOf("Reset");
    bank[0x1ffe] = reset & 0xff;
    bank[0x1fff] = (reset >> 8) & 0xff;
    const pce = run(new Pce(bank));
    expect([...pce.ram.subarray(0x200, 0x204)]).toEqual([1, 2, 3, 4]);
    expect(pce.cpu.y).toBe(0);
  });

  it("streams a run into a fixed pair of addresses with `tia`", () => {
    // The shape every video upload takes: the source walks and the destination
    // alternates between two bytes.
    const asm = new Asm6280(0xe000);
    asm.label("Reset");
    asm.lda(imm(0xf8));
    asm.tam(Asm6280.mprBit(1));
    asm.ldx(imm(0xff));
    asm.txs();
    asm.tia("Source", 0x2200, 4);
    asm.label("Done");
    asm.bra("Done");
    asm.label("Source");
    asm.db(0x11, 0x22, 0x33, 0x44);
    const code = asm.assemble();
    const bank = new Uint8Array(0x2000).fill(0xff);
    bank.set(code, 0);
    const reset = asm.addressOf("Reset");
    bank[0x1ffe] = reset & 0xff;
    bank[0x1fff] = (reset >> 8) & 0xff;
    const pce = run(new Pce(bank));
    // The last pair overwrote the first: two addresses, four bytes.
    expect([...pce.ram.subarray(0x200, 0x202)]).toEqual([0x33, 0x44]);
  });

  it("carries the carry the way the 6502 does — as no borrow", () => {
    const pce = run(
      machine((asm) => {
        asm.sec();
        asm.lda(imm(0x05));
        asm.sbc(imm(0x03));
        asm.sta(zp(0x00));
        // With the carry clear, one more comes off — which is how the divider's
        // floor adjustment is written.
        asm.clc();
        asm.lda(imm(0x05));
        asm.sbc(imm(0x03));
        asm.sta(zp(0x01));
      }),
    );
    expect(pce.ram[0]).toBe(0x02);
    expect(pce.ram[1]).toBe(0x01);
  });

  it("takes the 65C02 additions", () => {
    const pce = run(
      machine((asm) => {
        asm.lda(imm(0x40));
        asm.sta(zp(0x00));
        asm.stz(zp(0x01));
        asm.lda(imm(0x10));
        asm.ina();
        asm.sta(zp(0x02));
        asm.lda(imm(0x0f));
        asm.tsb(zp(0x00));
        asm.smb(7, 0x03);
      }),
    );
    expect(pce.ram[0]).toBe(0x4f);
    expect(pce.ram[1]).toBe(0x00);
    expect(pce.ram[2]).toBe(0x11);
    expect(pce.ram[3]).toBe(0x80);
  });

  it("reaches the video chip through `st0` without any page mapped to it", () => {
    const pce = run(
      machine((asm) => {
        asm.st0(0x00); // MAWR
        asm.st1(0x34);
        asm.st2(0x12);
      }),
    );
    // Nothing mapped bank `$FF` anywhere, and the register still arrived.
    expect(pce.vdc.vram.length).toBe(0x8000);
    asmWroteMawr(pce);
  });

  it("reads its pad as two nibbles, active low", () => {
    const pce = machine(() => {});
    pce.setButtons(["right", "run"]);
    // Directions with `SEL` low: bit 1 is right, and the bits are inverted.
    pce.write(0xff * 0x2000 + 0x1000, 0x00);
    expect(pce.read(0xff * 0x2000 + 0x1000) & 0x0f).toBe(0x0d);
    // Buttons with `SEL` high: `run` is bit 3 of the high nibble.
    pce.write(0xff * 0x2000 + 0x1000, 0x01);
    expect(pce.read(0xff * 0x2000 + 0x1000) & 0x0f).toBe(0x07);
  });

  it("refuses an opcode the code generator could not have meant", () => {
    const bank = new Uint8Array(0x2000).fill(0xff);
    // `$FF` is `bbs7`, which is legal — so plant one that is not.
    bank[0] = 0xef; // BBS6, also legal; use an undocumented hole instead
    bank[0] = 0x63;
    bank[0x1ffe] = 0x00;
    bank[0x1fff] = 0xe0;
    expect(() => new Pce(bank).stepInstruction()).toThrow(/illegal opcode/);
  });
});

/** The address port really did land on the video chip. */
function asmWroteMawr(pce: Pce): void {
  // Writing a word through the data port now lands at `$1234`, which is only
  // true if `st0`/`st1`/`st2` reached the VDC.
  pce.write(0xff * 0x2000 + 0x0000, 0x02);
  pce.write(0xff * 0x2000 + 0x0002, 0xcd);
  pce.write(0xff * 0x2000 + 0x0003, 0xab);
  expect(pce.vdc.vram[0x1234]).toBe(0xabcd);
}
