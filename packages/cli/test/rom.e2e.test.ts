/**
 * End-to-end ROM build (doc 06 §ROM building, doc 10).
 *
 * Exercises the real `demake gen --format rom` path through the local RGBDS
 * toolchain: image → prep → gen → rgbasm/rgblink/rgbfix → bootable ROM. It
 * self-skips when RGBDS is not on PATH, so the unit suite stays green without a
 * toolchain; provision one with `pnpm toolchains` to run it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeRgbaPng } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv, type CliEnv } from "../src/env.js";
import { EXIT } from "../src/exit-codes.js";
import { run } from "../src/run.js";

function samplePng(size = 32): Uint8Array {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      d[o] = Math.round((x / (size - 1)) * 255);
      d[o + 1] = Math.round((y / (size - 1)) * 255);
      d[o + 2] = 100;
      d[o + 3] = 255;
    }
  }
  return encodeRgbaPng(size, size, d);
}

/** A real-fs env with captured stdio (TTY, so binary never goes to stdout). */
function nodeEnvCapturing(): { env: CliEnv; out: () => string } {
  let out = "";
  const base = makeNodeEnv();
  const env: CliEnv = {
    ...base,
    out: (t) => {
      out += t;
    },
    errOut: () => {},
    stdoutIsTTY: () => true,
  };
  return { env, out: () => out };
}

const nodeEnv = makeNodeEnv();
const hasRgbds = nodeEnv.which("rgbasm") !== null;
const hasCc65 = nodeEnv.which("ca65") !== null && nodeEnv.which("ld65") !== null;
const hasWla = nodeEnv.which("wla-z80") !== null && nodeEnv.which("wlalink") !== null;
const hasM68k =
  nodeEnv.which("m68k-linux-gnu-as") !== null && nodeEnv.which("m68k-linux-gnu-objcopy") !== null;
const hasWla65816 = nodeEnv.which("wla-65816") !== null && nodeEnv.which("wlalink") !== null;
const hasArm =
  nodeEnv.which("arm-none-eabi-as") !== null && nodeEnv.which("arm-none-eabi-objcopy") !== null;
const maybe = hasRgbds ? it : it.skip;

describe("gen --format rom (E2E, needs RGBDS)", () => {
  for (const [consoleId, ext] of [
    ["dmg", ".gb"],
    ["gbc", ".gbc"],
  ] as const) {
    maybe(`assembles a bootable ${consoleId} ROM`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "demake-rom-e2e-"));
      try {
        const inPath = join(dir, "in.png");
        const outPath = join(dir, `out${ext}`);
        writeFileSync(inPath, samplePng());

        const { env, out } = nodeEnvCapturing();
        const code = await run(
          ["gen", inPath, "-c", consoleId, "--format", "rom", "-o", outPath, "--json"],
          env,
        );
        expect(code).toBe(EXIT.OK);
        expect(JSON.parse(out()).format).toBe("rom");

        const rom = readFileSync(outPath);
        expect(rom.length).toBe(32768); // a padded 32 KiB ROM
        // The Nintendo logo header rgbfix writes, at $0104.
        expect(rom[0x104]).toBe(0xce);
        expect(rom[0x105]).toBe(0xed);
        // Header checksum byte at $014D is non-zero (rgbfix computed it).
        expect(rom[0x14d]).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

/** Assert the CLI `--format rom` path assembles a plausible ROM for a family. */
function romCliCase(
  gate: boolean,
  consoleId: string,
  ext: string,
  check: (rom: Uint8Array) => void,
): void {
  (gate ? it : it.skip)(`assembles a bootable ${consoleId} ROM`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "demake-rom-e2e-"));
    try {
      const inPath = join(dir, "in.png");
      const outPath = join(dir, `out${ext}`);
      writeFileSync(inPath, samplePng());

      const { env, out } = nodeEnvCapturing();
      const code = await run(
        ["gen", inPath, "-c", consoleId, "--format", "rom", "-o", outPath, "--json"],
        env,
      );
      expect(code).toBe(EXIT.OK);
      expect(JSON.parse(out()).format).toBe("rom");
      check(readFileSync(outPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

describe("gen --format rom (E2E, needs cc65)", () => {
  romCliCase(hasCc65, "nes", ".nes", (rom) => {
    // iNES header magic + 16 KiB PRG + 8 KiB CHR (NROM-128).
    expect(rom.length).toBe(16 + 16384 + 8192);
    expect([rom[0], rom[1], rom[2], rom[3]]).toEqual([0x4e, 0x45, 0x53, 0x1a]);
  });
});

describe("gen --format rom (E2E, needs WLA-DX)", () => {
  romCliCase(hasWla, "sms", ".sms", (rom) => {
    expect(rom.length).toBe(32768); // two 16 KiB banks
  });
  romCliCase(hasWla, "gg", ".gg", (rom) => {
    expect(rom.length).toBe(32768);
  });
  romCliCase(hasWla, "sg1000", ".sg", (rom) => {
    expect(rom.length).toBeGreaterThan(0x100); // z80 reset vector + display code
  });
});

describe("gen --format rom (E2E, needs m68k binutils)", () => {
  romCliCase(hasM68k, "md", ".md", (rom) => {
    expect(rom.length).toBe(1 << 17); // padded to 128 KiB
    // The Mega Drive console signature the header carries at $100.
    expect(String.fromCharCode(...rom.slice(0x100, 0x104))).toBe("SEGA");
  });
});

describe("gen --format rom (E2E, needs WLA-DX 65816)", () => {
  romCliCase(hasWla65816, "snes", ".sfc", (rom) => {
    expect(rom.length).toBe(8 * 32768); // eight LoROM banks
    // The LoROM header's 21-character title sits at $7FC0.
    expect(String.fromCharCode(...rom.slice(0x7fc0, 0x7fc6))).toBe("demake");
  });
});

describe("gen --format rom (E2E, needs ARM binutils)", () => {
  romCliCase(hasArm, "gba", ".gba", (rom) => {
    // The cartridge entry point is an ARM branch (condition AL, opcode 0xEA),
    // and byte $B2 is the header's fixed value.
    expect(rom[3]).toBe(0xea);
    expect(rom[0xb2]).toBe(0x96);
    expect(String.fromCharCode(...rom.slice(0xa0, 0xa6))).toBe("DEMAKE");
  });
  romCliCase(hasArm, "nds", ".nds", (rom) => {
    const u32 = (off: number): number =>
      rom[off]! | (rom[off + 1]! << 8) | (rom[off + 2]! << 16) | (rom[off + 3]! << 24);
    expect(String.fromCharCode(...rom.slice(0, 6))).toBe("DEMAKE");
    expect(u32(0x020)).toBe(0x4000); // ARM9 ROM offset
    expect(u32(0x024)).toBe(0x02000000); // ARM9 entry
    expect(u32(0x028)).toBe(0x02000000); // ARM9 load address
    expect(u32(0x034)).toBe(0x02380000); // ARM7 entry
    expect(u32(0x02c)).toBeGreaterThan(0); // a non-empty ARM9 binary
    expect(u32(0x080)).toBeLessThanOrEqual(rom.length); // total used size fits
  });
});
