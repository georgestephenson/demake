import { describe, expect, it } from "vitest";

import {
  GB_TO_MEGADUCK,
  MEGADUCK_TO_GB,
  MEGADUCK_UNMAPPED,
  lcdcFromDuck,
  lcdcToDuck,
  megaduckRegister,
} from "../src/asm/megaduck.js";

/**
 * The Mega Duck's I/O map, against the hardware rather than against itself.
 *
 * Three things read this table — the emulator routes a write through it, the
 * audio driver emits a store from it, the game backend takes its video half —
 * and every one of them would keep passing if the table were *self-consistently
 * wrong*, because a cartridge built with a bad map, run on an emulator using the
 * same bad map, behaves perfectly. So these cases carry SameDuck's numbers
 * literally and compare against those.
 *
 * That is not hypothetical: building the inverse by flipping all 128 entries let
 * the identity entries overwrite the moved ones, so `OBP0` came back as `$48`
 * (its Game Boy address) instead of `$14`. Every other test in the repository
 * still passed.
 *
 * Source: SameDuck (a SameBoy fork), `Core/gb.h` and `Core/display.c`.
 */
describe("the Mega Duck's I/O map", () => {
  /** SameDuck's `GB_IO_*` enum: Game Boy register → Mega Duck offset. */
  const HARDWARE: readonly (readonly [string, number, number])[] = [
    // Video: $FF40-$FF4B becomes $FF10-$FF1B, in the console's own order.
    ["LCDC", 0x40, 0x10],
    ["STAT", 0x41, 0x11],
    ["SCY", 0x42, 0x12],
    ["SCX", 0x43, 0x13],
    ["OBP0", 0x48, 0x14],
    ["OBP1", 0x49, 0x15],
    ["WY", 0x4a, 0x16],
    ["WX", 0x4b, 0x17],
    ["LY", 0x44, 0x18],
    ["LYC", 0x45, 0x19],
    ["DMA", 0x46, 0x1a],
    ["BGP", 0x47, 0x1b],
    // Sound: $FF10-$FF26 becomes $FF20-$FF46, with four pairs swapped.
    ["NR10", 0x10, 0x20],
    ["NR11", 0x11, 0x22],
    ["NR12", 0x12, 0x21],
    ["NR13", 0x13, 0x23],
    ["NR14", 0x14, 0x24],
    ["NR21", 0x16, 0x25],
    ["NR22", 0x17, 0x27],
    ["NR23", 0x18, 0x28],
    ["NR24", 0x19, 0x29],
    ["NR30", 0x1a, 0x2a],
    ["NR31", 0x1b, 0x2b],
    ["NR32", 0x1c, 0x2c],
    ["NR33", 0x1d, 0x2e],
    ["NR34", 0x1e, 0x2d],
    ["NR41", 0x20, 0x40],
    ["NR42", 0x21, 0x42],
    ["NR43", 0x22, 0x41],
    ["NR44", 0x23, 0x43],
    ["NR50", 0x24, 0x44],
    ["NR51", 0x25, 0x46],
    ["NR52", 0x26, 0x45],
  ];

  it.each(HARDWARE)("puts %s at the address the hardware does", (_name, gb, duck) => {
    expect(megaduckRegister(gb)).toBe(duck);
    expect(GB_TO_MEGADUCK[gb]).toBe(duck);
    expect(MEGADUCK_TO_GB[duck]).toBe(gb);
  });

  it("leaves wave RAM, the timer, the joypad and the interrupt flag alone", () => {
    for (const at of [0x00, 0x01, 0x02, 0x04, 0x05, 0x06, 0x07, 0x0f]) {
      expect(megaduckRegister(at)).toBe(at);
      expect(MEGADUCK_TO_GB[at]).toBe(at);
    }
    for (let at = 0x30; at <= 0x3f; at += 1) {
      expect(megaduckRegister(at)).toBe(at);
      expect(MEGADUCK_TO_GB[at]).toBe(at);
    }
  });

  it("round-trips every register that exists, and sends no two to one place", () => {
    // A register two others map onto is a register whose writes silently erase
    // each other, which is the failure the inverse bug produced. Over the *real*
    // registers, not the whole page: a Game Boy has nothing at `$2C`, so where
    // that address points on a Duck is not a question either table answers.
    const registers = [
      ...HARDWARE.map(([, gb]) => gb),
      ...[0x00, 0x01, 0x02, 0x04, 0x05, 0x06, 0x07, 0x0f],
      ...Array.from({ length: 16 }, (_, index) => 0x30 + index),
    ];
    for (const gb of registers) {
      expect(MEGADUCK_TO_GB[megaduckRegister(gb)], `gb $${gb.toString(16)}`).toBe(gb);
    }
    expect(new Set(registers.map(megaduckRegister)).size).toBe(registers.length);
  });

  it("has nothing at the offsets the move left empty", () => {
    // $1C-$1F is the gap between the video registers and the sound ones, and
    // $47-$4B the one after them. Both are real registers on a Game Boy — the
    // wave channel's volume and period, and the palettes — so an identity
    // fall-through here would let a write to an address with nothing behind it
    // change the sound of the music.
    for (const at of [0x1c, 0x1d, 0x1e, 0x1f, 0x47, 0x48, 0x49, 0x4a, 0x4b]) {
      expect(MEGADUCK_TO_GB[at], `duck $${at.toString(16)}`).toBe(MEGADUCK_UNMAPPED);
    }
    // And every offset that *is* a register maps to a distinct one.
    const mapped = MEGADUCK_TO_GB.filter((gb) => gb !== MEGADUCK_UNMAPPED);
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it("permutes LCDC's five moved bits and leaves the other three", () => {
    // Bit by bit, against SameDuck's `display.c`: the Duck's bit 0 is object
    // enable (the Game Boy's bit 1), its bit 6 is background enable (bit 0),
    // and tile-data select, window enable and LCD enable did not move.
    for (const [duckBit, gbBit] of [
      [0, 1], // OBJ enable
      [1, 2], // OBJ size
      [2, 3], // BG map
      [3, 6], // window map
      [4, 4], // tile data select
      [5, 5], // window enable
      [6, 0], // BG enable
      [7, 7], // LCD enable
    ] as const) {
      expect(lcdcFromDuck(1 << duckBit)).toBe(1 << gbBit);
      expect(lcdcToDuck(1 << gbBit)).toBe(1 << duckBit);
    }
    // The value the runtime writes to turn everything on.
    expect(lcdcFromDuck(0b11010001)).toBe(0b10010011);
    expect(lcdcToDuck(0b10010011)).toBe(0b11010001);
  });

  it("round-trips every LCDC byte", () => {
    for (let value = 0; value < 256; value += 1) {
      expect(lcdcToDuck(lcdcFromDuck(value))).toBe(value);
      expect(lcdcFromDuck(lcdcToDuck(value))).toBe(value);
    }
  });
});
