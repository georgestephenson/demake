/**
 * The Neo Geo Pocket cartridge wrapper and the console's memory map.
 *
 * The wrapper is tested because it decides output bytes. The map is tested for
 * a different reason: its constants are literals, so restating them here would
 * be a copy rather than a check — what is worth pinning is the *arithmetic*
 * between them, because a region that quietly overlapped its neighbour is
 * exactly the kind of machine description that is wrong and consistent and
 * passes everything (AGENTS.md §Gotchas).
 *
 * Sources: the Neo Geo Pocket Color technical reference (`ngpcspec.txt`,
 * devrs.com).
 */

import { describe, expect, it } from "vitest";

import {
  NGP_CHARACTER_BYTES,
  NGP_CHARACTER_COUNT,
  NGP_CHARACTERS,
  NGP_PALETTE,
  NGP_PALETTE_STRIDE,
  NGP_PLANE1,
  NGP_PLANE2,
  NGP_PLANE_COLUMNS,
  NGP_PLANE_ROWS,
  NGP_RAM,
  NGP_RAM_RESERVED,
  NGP_RAM_USABLE,
  NGP_SPRITE_COUNT,
  NGP_SPRITES,
  NGP_Z80_RAM,
} from "../src/asm/ngp.js";
import {
  NGP_ENTRY_OFFSET,
  NGP_HEADER_SIZE,
  NGP_RECOGNITION_CODE,
  NGP_ROM_BASE,
  NGP_ROM_SIZES,
  NGP_SYSTEM_COLOR,
  NGP_SYSTEM_MONO,
  ngpRomSize,
  packNgpRom,
} from "../src/asm/ngp-cart.js";

const text = (rom: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...rom.subarray(at, at + length));

describe("the Neo Geo Pocket cartridge wrapper", () => {
  it("puts the program straight after the header and points the entry at it", () => {
    const rom = packNgpRom(Uint8Array.of(0x00, 0x05, 0x1a));
    expect(rom.length).toBe(NGP_ROM_SIZES[0]);
    expect([...rom.subarray(NGP_HEADER_SIZE, NGP_HEADER_SIZE + 3)]).toEqual([0x00, 0x05, 0x1a]);
    // The entry address is 24 bits in a four-byte field, little-endian.
    const entry = NGP_ROM_BASE + NGP_HEADER_SIZE;
    expect([...rom.subarray(NGP_ENTRY_OFFSET, NGP_ENTRY_OFFSET + 4)]).toEqual([
      entry & 0xff,
      (entry >> 8) & 0xff,
      (entry >> 16) & 0xff,
      0x00,
    ]);
  });

  it("leaves the recognition code blank unless it is asked for", () => {
    // It is SNK's copyright claim, and a demade cartridge is not theirs — the
    // same bargain `gb-cart.ts` strikes with the Nintendo boot logo.
    const plain = packNgpRom(Uint8Array.of(0x00));
    expect([...plain.subarray(0, NGP_ENTRY_OFFSET)]).toEqual(Array<number>(28).fill(0));
    const stamped = packNgpRom(Uint8Array.of(0x00), { recognition: true });
    expect(text(stamped, 0, 28)).toBe(NGP_RECOGNITION_CODE);
    // Twenty-eight characters exactly, so the field is full and the entry
    // address that follows it has not moved.
    expect(NGP_RECOGNITION_CODE).toHaveLength(NGP_ENTRY_OFFSET);
  });

  it("says which machine may run the cartridge in one byte", () => {
    expect(packNgpRom(Uint8Array.of(0), {})[0x23]).toBe(NGP_SYSTEM_MONO);
    expect(packNgpRom(Uint8Array.of(0), { color: true })[0x23]).toBe(NGP_SYSTEM_COLOR);
  });

  it("pads a title to twelve characters and cuts a longer one", () => {
    expect(text(packNgpRom(Uint8Array.of(0), { title: "CAVES" }), 0x24, 12)).toBe("CAVES       ");
    expect(text(packNgpRom(Uint8Array.of(0), { title: "A VERY LONG NAME" }), 0x24, 12)).toBe(
      "A VERY LONG ",
    );
  });

  it("stamps the software id little-endian and its revision beside it", () => {
    const rom = packNgpRom(Uint8Array.of(0), { softwareId: 0x1234, version: 2 });
    expect([...rom.subarray(0x20, 0x23)]).toEqual([0x34, 0x12, 0x02]);
  });

  it("writes the reserved field as zero and pads the rest to the erased state", () => {
    const rom = packNgpRom(Uint8Array.of(0xaa));
    expect([...rom.subarray(0x30, 0x40)]).toEqual(Array<number>(16).fill(0));
    // Flash comes erased as $FF, so that is what the unused cartridge is.
    expect(rom[NGP_HEADER_SIZE + 1]).toBe(0xff);
    expect(rom[rom.length - 1]).toBe(0xff);
  });

  it("takes the smallest board that holds the program", () => {
    expect(ngpRomSize(1)).toBe(NGP_ROM_SIZES[0]);
    expect(ngpRomSize(NGP_ROM_SIZES[0] as number)).toBe(NGP_ROM_SIZES[0]);
    expect(ngpRomSize((NGP_ROM_SIZES[0] as number) + 1)).toBe(NGP_ROM_SIZES[1]);
    expect(ngpRomSize(NGP_ROM_SIZES[2] as number)).toBe(NGP_ROM_SIZES[2]);
    // A program the header cannot describe is refused rather than truncated.
    expect(() => ngpRomSize((NGP_ROM_SIZES[2] as number) + 1)).toThrow(/largest cartridge/);
    // The header counts against the board, so a program one byte short of a
    // board's size still needs the next one up.
    const big = new Uint8Array(NGP_ROM_SIZES[0] as number);
    expect(packNgpRom(big).length).toBe(NGP_ROM_SIZES[1]);
  });

  it("refuses a size that is not a board", () => {
    expect(() => packNgpRom(Uint8Array.of(0), { size: 0x40000 })).toThrow(/not 262144/);
  });
});

describe("the Neo Geo Pocket memory map", () => {
  it("stops work RAM where the boot ROM's own area begins", () => {
    expect(NGP_RAM_USABLE).toBe(NGP_RAM_RESERVED - NGP_RAM);
    // And the reserved area ends where the sound processor's RAM starts, so
    // there is no gap the allocator could be tempted into.
    expect(NGP_RAM_RESERVED + 0x400).toBe(NGP_Z80_RAM);
  });

  it("gives each layer a palette block that does not reach the next one's", () => {
    // Sixteen palettes of four RGB444 entries, two bytes each.
    expect(NGP_PALETTE_STRIDE).toBe(16 * 4 * 2);
    // Three blocks — sprites, plane 1, plane 2 — before the mono machine's own
    // tables at $8380.
    expect(NGP_PALETTE + 3 * NGP_PALETTE_STRIDE).toBe(0x008380);
  });

  it("sizes the scroll planes and the character bank as the hardware does", () => {
    // A map entry is two bytes, so a 32×32 plane is exactly the two kilobytes
    // between one plane and the next.
    expect(NGP_PLANE_COLUMNS * NGP_PLANE_ROWS * 2).toBe(NGP_PLANE2 - NGP_PLANE1);
    // The character bank is eight kilobytes and ends where the map does.
    expect(NGP_CHARACTERS + NGP_CHARACTER_COUNT * NGP_CHARACTER_BYTES).toBe(0x00c000);
    // Sixty-four objects of four bytes fit inside the table's own page.
    expect(NGP_SPRITE_COUNT * 4).toBe(0x100);
    expect(NGP_SPRITES + NGP_SPRITE_COUNT * 4).toBe(0x008900);
  });
});
