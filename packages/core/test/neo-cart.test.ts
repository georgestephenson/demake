/**
 * The Neo Geo's two graphics formats, pinned against the format description.
 *
 * Every case that matters here computes its expected byte offset **by hand**
 * from the wiki's own rules rather than by calling the decoder beside the
 * encoder. That is `megaduck.test.ts`'s discipline and it exists for the reason
 * AGENTS.md §Gotchas states: a machine description that is wrong *and*
 * consistent passes every test there is. Both of these formats have a
 * right-half-before-left quirk that a self-consistent pair would hide
 * completely, and the Neo Geo Pocket's BGR palette is what happens when nothing
 * checks.
 */

import {
  NEO_CODE_ORIGIN,
  NEO_FIX_TILE_BYTES,
  NEO_TILE_PLANE_BYTES,
  NEO_USER_ENTRY,
  packNeoCharacters,
  packNeoFix,
  packNeoHeader,
  packNeoRom,
  unpackNeoCharacters,
  unpackNeoFix,
} from "@demake/core";
import { describe, expect, it } from "vitest";

/** A 16×16 tile with a single pixel set. */
function oneSpritePixel(x: number, y: number, value: number): Uint8Array {
  const pixels = new Uint8Array(256);
  pixels[y * 16 + x] = value;
  return pixels;
}

/** An 8×8 fix tile with a single pixel set. */
function oneFixPixel(x: number, y: number, value: number): Uint8Array {
  const pixels = new Uint8Array(64);
  pixels[y * 8 + x] = value;
  return pixels;
}

describe("the sprite tile format", () => {
  it("stores the top-right 8×8 block first, which is the quirk", () => {
    // Pixel (8, 0) is the first pixel of block 0 — the top *right* block. Block
    // 0 occupies bytes 0–15, row 0 is bytes 0–1, and column 0 of the block is
    // bit 7. Value 1 sets plane 0 only, which is c1's first byte of the pair.
    const { c1, c2 } = packNeoCharacters(oneSpritePixel(8, 0, 1));
    expect(c1[0]).toBe(0x80);
    expect(c1[1]).toBe(0x00);
    expect(c2[0]).toBe(0x00);

    // Pixel (0, 0) is the first pixel of block *2*, the top left, at byte 32.
    const left = packNeoCharacters(oneSpritePixel(0, 0, 1));
    expect(left.c1[32]).toBe(0x80);
    expect(left.c1[0]).toBe(0x00);
  });

  it("puts the bottom-right block second and the bottom-left last", () => {
    // (8, 8) is block 1's origin, byte 16.
    expect(packNeoCharacters(oneSpritePixel(8, 8, 1)).c1[16]).toBe(0x80);
    // (0, 8) is block 3's origin, byte 48.
    expect(packNeoCharacters(oneSpritePixel(0, 8, 1)).c1[48]).toBe(0x80);
  });

  it("splits the planes across the ROM pair, two bytes a row each", () => {
    // Value 15 sets all four planes: plane 0 and 1 in c1, plane 2 and 3 in c2.
    const { c1, c2 } = packNeoCharacters(oneSpritePixel(8, 0, 0xf));
    expect([c1[0], c1[1], c2[0], c2[1]]).toEqual([0x80, 0x80, 0x80, 0x80]);

    // Value 4 is plane 2 alone, which lives in c2's *first* byte of the pair.
    const plane2 = packNeoCharacters(oneSpritePixel(8, 0, 4));
    expect([plane2.c1[0], plane2.c1[1], plane2.c2[0], plane2.c2[1]]).toEqual([0, 0, 0x80, 0]);
  });

  it("puts the leftmost pixel of a row in the most significant bit", () => {
    // Block 0 spans x 8–15, so x=15 is its column 7 — bit 0.
    expect(packNeoCharacters(oneSpritePixel(15, 0, 1)).c1[0]).toBe(0x01);
    expect(packNeoCharacters(oneSpritePixel(9, 0, 1)).c1[0]).toBe(0x40);
  });

  it("uses 64 bytes a tile in each ROM of the pair", () => {
    const two = new Uint8Array(512);
    const { c1, c2 } = packNeoCharacters(two);
    expect(c1.length).toBe(2 * NEO_TILE_PLANE_BYTES);
    expect(c2.length).toBe(2 * NEO_TILE_PLANE_BYTES);
  });

  it("round-trips every pixel value at every position", () => {
    const pixels = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) pixels[index] = index & 0xf;
    const { c1, c2 } = packNeoCharacters(pixels);
    expect([...unpackNeoCharacters(c1, c2)]).toEqual([...pixels]);
  });
});

describe("the fix tile format", () => {
  it("stores the right half first, which is the same quirk", () => {
    // `H = 0` is the right-hand four columns, so x=4 is byte 0 of the tile.
    expect(packNeoFix(oneFixPixel(4, 0, 1))[0]).toBe(0x01);
    // x=0 is the left half, `H = 1`, which starts at byte 16.
    expect(packNeoFix(oneFixPixel(0, 0, 1))[16]).toBe(0x01);
  });

  it("swaps the pixels inside a byte: the left one is the low nibble", () => {
    // x=4 and x=5 share byte 0. The left of the pair goes low.
    expect(packNeoFix(oneFixPixel(4, 0, 0xa))[0]).toBe(0x0a);
    expect(packNeoFix(oneFixPixel(5, 0, 0xa))[0]).toBe(0xa0);
  });

  it("walks a column top to bottom before moving to the next pair", () => {
    // Row is the low three bits, so (4, 3) is byte 3 and (6, 0) is byte 8.
    expect(packNeoFix(oneFixPixel(4, 3, 1))[3]).toBe(0x01);
    expect(packNeoFix(oneFixPixel(6, 0, 1))[8]).toBe(0x01);
  });

  it("uses 32 bytes a tile", () => {
    expect(packNeoFix(new Uint8Array(128)).length).toBe(2 * NEO_FIX_TILE_BYTES);
  });

  it("round-trips every pixel value at every position", () => {
    const pixels = new Uint8Array(64);
    for (let index = 0; index < 64; index += 1) pixels[index] = index & 0xf;
    expect([...unpackNeoFix(packNeoFix(pixels))]).toEqual([...pixels]);
  });
});

describe("the program header", () => {
  const header = packNeoHeader(0x8000, {
    stack: 0x10f300,
    user: 0x00000300,
    vblank: 0x00000400,
  });

  it("puts the stack pointer and the reset vector where the 68000 reads them", () => {
    expect([...header.slice(0, 8)]).toEqual([0x00, 0x10, 0xf3, 0x00, 0x00, 0x00, 0x03, 0x00]);
  });

  it("puts vertical blank at $64, which is level 1 and not the Mega Drive's level 6", () => {
    expect([...header.slice(0x64, 0x68)]).toEqual([0x00, 0x00, 0x04, 0x00]);
    // Level 6's autovector must be untouched: this console does not use it.
    expect([...header.slice(0x78, 0x7c)]).toEqual([0, 0, 0, 0]);
  });

  it("carries the string the hardware recognises a cartridge by", () => {
    expect(String.fromCharCode(...header.slice(0x100, 0x107))).toBe("NEO-GEO");
  });

  it("enters the game through a JMP at the documented USER offset", () => {
    // `jmp <abs>.l` is $4EF9 followed by the address.
    expect([...header.slice(NEO_USER_ENTRY, NEO_USER_ENTRY + 6)]).toEqual([
      0x4e, 0xf9, 0x00, 0x00, 0x03, 0x00,
    ]);
  });

  it("records the P ROM's size and leaves room for the program at $200", () => {
    expect([...header.slice(0x10a, 0x10e)]).toEqual([0x00, 0x00, 0x80, 0x00]);
    expect(header.length).toBe(NEO_CODE_ORIGIN);
  });
});

describe("the .neo container", () => {
  it("names each region's length and lays them out end to end", () => {
    const p = new Uint8Array(0x400).fill(0x11);
    const s = new Uint8Array(0x40).fill(0x22);
    const c1 = new Uint8Array(0x40).fill(0x33);
    const c2 = new Uint8Array(0x40).fill(0x44);
    const rom = packNeoRom({ p, s, c1, c2 }, { name: "pong" });

    expect(String.fromCharCode(...rom.slice(0, 3))).toBe("NEO");
    const view = new DataView(rom.buffer, rom.byteOffset);
    expect(view.getUint32(0x04, true)).toBe(p.length);
    expect(view.getUint32(0x08, true)).toBe(s.length);
    expect(view.getUint32(0x18, true)).toBe(c1.length + c2.length);
    // No Z80 program, so the sound regions are empty rather than absent.
    expect([view.getUint32(0x0c, true), view.getUint32(0x10, true)]).toEqual([0, 0]);
    expect(String.fromCharCode(...rom.slice(0x2c, 0x30))).toBe("pong");

    expect(rom.length).toBe(4096 + p.length + s.length + c1.length + c2.length);
    expect(rom[4096]).toBe(0x11);
    expect(rom[4096 + p.length]).toBe(0x22);
    // The C pair is interleaved, odd ROM at even offsets.
    const cAt = 4096 + p.length + s.length;
    expect([rom[cAt], rom[cAt + 1]]).toEqual([0x33, 0x44]);
  });
});
