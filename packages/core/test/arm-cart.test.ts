/**
 * The Game Boy Advance and Nintendo DS cartridge wrappers.
 *
 * Tested for the reason every other wrapper here is: the header fields are the
 * one part of a build nothing downstream can check. A wrong tile is visible, a
 * wrong opcode traps, and a wrong complement byte produces a cartridge that runs
 * in every emulator and on no hardware.
 *
 * The two consoles fail differently, which is why both are here. A GBA header
 * *interleaves* with the program — the first word is the entry branch, so a
 * builder that prepended a header would push the code 192 bytes past the address
 * the console starts at. A DS header **is** the only statement of which bytes
 * belong to which processor, so an off-by-one in its offsets is a cartridge that
 * runs a sound driver as a game.
 */

import { describe, expect, it } from "vitest";

import { AsmArm, armImm } from "../src/asm/arm.js";
import {
  GBA_CHECK_END,
  GBA_CHECK_OFFSET,
  GBA_CHECK_START,
  GBA_HEADER_SIZE,
  GBA_ORIGIN,
  gbaComplement,
  packGbaRom,
} from "../src/asm/gba-cart.js";
import {
  NDS_ARM7_RAM,
  NDS_ARM9_RAM,
  NDS_HEADER_SIZE,
  ndsCrc16,
  packNdsRom,
} from "../src/asm/nds-cart.js";

/** A minimal cartridge body: the entry branch, the header's space, some code. */
function body(): Uint8Array {
  const asm = new AsmArm(GBA_ORIGIN);
  asm.b("start");
  asm.padTo(GBA_ORIGIN + GBA_HEADER_SIZE);
  asm.label("start");
  asm.mov(0, armImm(0));
  asm.b("start");
  return asm.assemble();
}

describe("the Game Boy Advance cartridge", () => {
  it("keeps the program's first word as the entry branch", () => {
    const rom = packGbaRom(body());
    // `b start` — the header is 0xC0 bytes and the branch reads pc+8, so the
    // displacement is (0xC0 − 8) / 4 = 0x2E.
    expect(rom[0]).toBe(0x2e);
    expect(rom[3]).toBe(0xea);
  });

  it("computes the complement the BIOS checks", () => {
    const rom = packGbaRom(body(), { title: "PONG", code: "APNE", maker: "01" });
    let sum = 0;
    for (let at = GBA_CHECK_START; at <= GBA_CHECK_END; at += 1) sum += rom[at] as number;
    expect((sum + (rom[GBA_CHECK_OFFSET] as number) + 0x19) & 0xff).toBe(0);
    expect(gbaComplement(rom)).toBe(rom[GBA_CHECK_OFFSET]);
  });

  it("writes the title, the codes and the fixed byte where the header says", () => {
    const rom = packGbaRom(body(), { title: "CAVES", code: "ACVE", maker: "77" });
    const text = (at: number, length: number): string =>
      String.fromCharCode(...rom.subarray(at, at + length)).replace(/\0+$/, "");
    expect(text(0xa0, 12)).toBe("CAVES");
    expect(text(0xac, 4)).toBe("ACVE");
    expect(text(0xb0, 2)).toBe("77");
    expect(rom[0xb2]).toBe(0x96);
  });

  it("leaves the logo area zero, because demake ships no copyrighted logo", () => {
    const rom = packGbaRom(body());
    expect([...rom.subarray(0x04, 0xa0)].every((byte) => byte === 0)).toBe(true);
  });

  it("refuses a program too short to hold its own header", () => {
    expect(() => packGbaRom(new Uint8Array(16))).toThrow(/at least 192 bytes/);
  });

  it("pads to a whole number of 32 KiB banks and holds the code unchanged", () => {
    const code = body();
    const rom = packGbaRom(code);
    expect(rom.length).toBe(0x8000);
    expect([...rom.subarray(GBA_HEADER_SIZE, code.length)]).toEqual([
      ...code.subarray(GBA_HEADER_SIZE),
    ]);
  });
});

describe("the Nintendo DS cartridge", () => {
  /** Two distinguishable programs, so a swapped pair would be visible. */
  const arm9 = Uint8Array.from({ length: 64 }, (_, index) => (index + 1) & 0xff);
  const arm7 = Uint8Array.from({ length: 32 }, (_, index) => (0x80 + index) & 0xff);

  it("places each processor's binary where its own header field says", () => {
    const rom = packNdsRom(arm9, arm7);
    const view = new DataView(rom.buffer);
    const arm9Offset = view.getUint32(0x020, true);
    const arm7Offset = view.getUint32(0x030, true);
    expect(arm9Offset).toBe(NDS_HEADER_SIZE);
    expect(view.getUint32(0x024, true)).toBe(NDS_ARM9_RAM);
    expect(view.getUint32(0x028, true)).toBe(NDS_ARM9_RAM);
    expect(view.getUint32(0x02c, true)).toBe(arm9.length);
    expect(view.getUint32(0x034, true)).toBe(NDS_ARM7_RAM);
    expect(view.getUint32(0x038, true)).toBe(NDS_ARM7_RAM);
    expect(view.getUint32(0x03c, true)).toBe(arm7.length);
    expect([...rom.subarray(arm9Offset, arm9Offset + arm9.length)]).toEqual([...arm9]);
    expect([...rom.subarray(arm7Offset, arm7Offset + arm7.length)]).toEqual([...arm7]);
  });

  it("aligns the second binary, so neither program starts mid-word", () => {
    const rom = packNdsRom(new Uint8Array(0x101), arm7);
    const arm7Offset = new DataView(rom.buffer).getUint32(0x030, true);
    expect(arm7Offset % 0x200).toBe(0);
    expect(arm7Offset).toBeGreaterThanOrEqual(NDS_HEADER_SIZE + 0x101);
  });

  it("checksums the header over everything before the field itself", () => {
    const rom = packNdsRom(arm9, arm7);
    const stored = new DataView(rom.buffer).getUint16(0x15e, true);
    expect(stored).toBe(ndsCrc16(rom.subarray(0, 0x15e)));
    // A header byte that changed without the CRC changing is the failure this
    // field exists to catch, so check the CRC actually depends on one.
    const tampered = rom.slice();
    tampered[0x00] = (tampered[0x00] as number) ^ 0xff;
    expect(ndsCrc16(tampered.subarray(0, 0x15e))).not.toBe(stored);
  });

  it("rounds the image to a power of two of at least 128 KiB", () => {
    expect(packNdsRom(arm9, arm7).length).toBe(1 << 17);
    expect(packNdsRom(new Uint8Array(0x40000), arm7).length).toBe(1 << 19);
  });
});
