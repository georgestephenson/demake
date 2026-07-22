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

const hasRgbds = makeNodeEnv().which("rgbasm") !== null;
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
