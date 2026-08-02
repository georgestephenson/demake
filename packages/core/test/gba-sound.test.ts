import { describe, expect, it } from "vitest";

import {
  GB_TO_GBA_SOUND,
  GBA_SOUND_BASE,
  GBA_SOUND_TO_GB,
  GBA_SOUND_UNMAPPED,
  gbaSoundAddress,
  gbaSoundRegister,
} from "../src/asm/gba-sound.js";

/**
 * The Game Boy Advance's sound page, against the hardware rather than against
 * itself.
 *
 * Two things read this table in opposite directions — `@demake/gba` routes a
 * store through it and `@demake/audio`'s ARM driver emits one from it — and both
 * would keep passing if the table were *self-consistently wrong*, because a
 * cartridge built with a bad map, run on a core using the same bad map, sounds
 * perfect and would be silent on hardware. That is the Mega Duck's lesson
 * (`megaduck.test.ts`), and it is why the cases below carry GBATEK's addresses
 * literally instead of comparing the table with its own inverse.
 *
 * Source: GBATEK — *GBA Sound Controller* (https://problemkaputt.de/gbatek.htm).
 */
describe("the Game Boy Advance's sound page", () => {
  /** GBATEK's `SOUND*` addresses: Game Boy register → this console's address. */
  const HARDWARE: readonly (readonly [string, number, number])[] = [
    // Channel 1: SOUND1CNT_L/H/X at $4000060/$4000062/$4000064.
    ["NR10", 0x10, 0x04000060],
    ["NR11", 0x11, 0x04000062],
    ["NR12", 0x12, 0x04000063],
    ["NR13", 0x13, 0x04000064],
    ["NR14", 0x14, 0x04000065],
    // Channel 2: SOUND2CNT_L/H at $4000068/$400006C — and the gap at $400006A
    // is real, which is the whole reason this is a table and not a stride.
    ["NR21", 0x16, 0x04000068],
    ["NR22", 0x17, 0x04000069],
    ["NR23", 0x18, 0x0400006c],
    ["NR24", 0x19, 0x0400006d],
    // Channel 3: SOUND3CNT_L/H/X at $4000070/$4000072/$4000074.
    ["NR30", 0x1a, 0x04000070],
    ["NR31", 0x1b, 0x04000072],
    ["NR32", 0x1c, 0x04000073],
    ["NR33", 0x1d, 0x04000074],
    ["NR34", 0x1e, 0x04000075],
    // Channel 4: SOUND4CNT_L/H at $4000078/$400007C.
    ["NR41", 0x20, 0x04000078],
    ["NR42", 0x21, 0x04000079],
    ["NR43", 0x22, 0x0400007c],
    ["NR44", 0x23, 0x0400007d],
    // Control: SOUNDCNT_L at $4000080 and SOUNDCNT_X at $4000084. The register
    // between them — SOUNDCNT_H at $4000082 — is the *sample* channels' and has
    // no Game Boy counterpart at all, which is why it is absent below.
    ["NR50", 0x24, 0x04000080],
    ["NR51", 0x25, 0x04000081],
    ["NR52", 0x26, 0x04000084],
  ];

  for (const [name, register, address] of HARDWARE) {
    it(`puts ${name} at $${address.toString(16)}`, () => {
      expect(gbaSoundAddress(register)).toBe(address);
      expect(gbaSoundRegister(address - 0x04000000)).toBe(register);
    });
  }

  it("keeps wave RAM where a Game Boy has it, sixteen bytes of it", () => {
    // $4000090-$400009F, and the Game Boy's $FF30-$FF3F. The hardware banks two
    // sets of sixteen behind `NR30`'s bit 6; a demade schedule uses the one that
    // is selected, which is what a Game Boy has.
    for (let index = 0; index < 16; index += 1) {
      expect(gbaSoundAddress(0x30 + index)).toBe(0x04000090 + index);
      expect(gbaSoundRegister(0x090 + index)).toBe(0x30 + index);
    }
  });

  it("says nothing at all about an address with no register behind it", () => {
    // The gaps are real: this console spaces its channels on a four-byte grid
    // and a Game Boy spaces them on a five-byte one, so the arrangement that
    // looks like an offset stops holding at the wave channel. An offset that fell
    // through as identity would let a write to an empty address change the music,
    // which is exactly what the Mega Duck's map did twice.
    for (const offset of [0x061, 0x066, 0x067, 0x06a, 0x06b, 0x071, 0x076, 0x07a, 0x082]) {
      expect(gbaSoundRegister(offset)).toBe(GBA_SOUND_UNMAPPED);
    }
    expect(gbaSoundRegister(GBA_SOUND_BASE - 1)).toBe(GBA_SOUND_UNMAPPED);
  });

  it("refuses a register this console does not have rather than guessing one", () => {
    // $15, $1F and $27 are holes in the Game Boy's own numbering. An address
    // returned for one of them would be a store the driver makes and nobody
    // reads — silent, and impossible to see in a register diff.
    for (const register of [0x15, 0x1f, 0x27, 0x40]) {
      expect(() => gbaSoundAddress(register)).toThrow();
      expect(GB_TO_GBA_SOUND[register] ?? GBA_SOUND_UNMAPPED).toBe(GBA_SOUND_UNMAPPED);
    }
  });

  it("is one table read two ways, and the two agree everywhere", () => {
    // Not the primary assertion — the literal cases above are — but a round trip
    // catches an entry added to one direction and not the other.
    for (let register = 0; register < GB_TO_GBA_SOUND.length; register += 1) {
      const offset = GB_TO_GBA_SOUND[register] as number;
      if (offset === GBA_SOUND_UNMAPPED) continue;
      expect(gbaSoundRegister(offset)).toBe(register);
    }
    for (let index = 0; index < GBA_SOUND_TO_GB.length; index += 1) {
      const register = GBA_SOUND_TO_GB[index] as number;
      if (register === GBA_SOUND_UNMAPPED) continue;
      expect(GB_TO_GBA_SOUND[register]).toBe(GBA_SOUND_BASE + index);
    }
  });
});
