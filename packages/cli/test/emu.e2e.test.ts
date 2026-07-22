/**
 * Pixel-perfect emulator E2E (doc 10 — the credo).
 *
 * The whole loop, end to end: image → prep → gen → ROM → boot in SameBoy (the
 * accuracy reference) → capture the framebuffer → assert it is byte-identical to
 * demake's DAC-decoded reference. SameBoy runs with color correction disabled,
 * so its output is the raw hardware readout (CGB: RGB555 expanded exactly as
 * demake's `expandChannel`; DMG: the exact green ramp), directly comparable to
 * `renderCompliant`.
 *
 * Self-skips unless both RGBDS and the SameBoy capturer are provisioned (`pnpm
 * toolchains && pnpm emulator`). Nothing here needs Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { encodeRgbaPng, gen, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv, type CliEnv } from "../src/env.js";
import { EXIT } from "../src/exit-codes.js";
import { run } from "../src/run.js";

const SAMEBOY_VERSION = "1.0.1";
const EMU_DIR =
  process.env.DEMAKE_EMU_DIR ??
  join(homedir(), ".cache", "demake", "toolchains", `sameboy-${SAMEBOY_VERSION}`);
const CAPTURE = join(EMU_DIR, "capture");
const FRAMES = 300;

const hasToolchain = makeNodeEnv().which("rgbasm") !== null;
const hasEmu = existsSync(CAPTURE) && existsSync(join(EMU_DIR, "dmg_boot.bin"));
const maybe = hasToolchain && hasEmu ? it : it.skip;

function samplePng(size = 32): Uint8Array {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      d[o] = (x * 8) & 0xff;
      d[o + 1] = (y * 8) & 0xff;
      d[o + 2] = 100;
      d[o + 3] = 255;
    }
  }
  return encodeRgbaPng(size, size, d);
}

/** Parse a binary PPM (P6) into { w, h, data } (RGB, 3 bytes/px). */
function readPpm(bytes: Uint8Array): { w: number; h: number; data: Uint8Array } {
  const tokens: string[] = [];
  let pos = 0;
  const ws = (b: number): boolean => b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0d;
  while (tokens.length < 4) {
    while (ws(bytes[pos]!)) pos += 1;
    let s = "";
    while (pos < bytes.length && !ws(bytes[pos]!)) s += String.fromCharCode(bytes[pos++]!);
    tokens.push(s);
  }
  pos += 1; // the single whitespace after maxval
  return { w: Number(tokens[1]), h: Number(tokens[2]), data: bytes.subarray(pos) };
}

/** A real-fs env with captured stdio (TTY, so nothing binary hits stdout). */
function nodeEnvCapturing(): CliEnv {
  return { ...makeNodeEnv(), out: () => {}, errOut: () => {}, stdoutIsTTY: () => true };
}

describe("pixel-perfect emulator E2E (needs RGBDS + SameBoy)", () => {
  for (const [consoleId, model, ext] of [
    ["dmg", "dmg", ".gb"],
    ["gbc", "cgb", ".gbc"],
  ] as const) {
    maybe(`${consoleId}: ROM boots in SameBoy and matches the DAC reference`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "demake-emu-"));
      try {
        const png = samplePng();
        const inPath = join(dir, "in.png");
        const romPath = join(dir, `out${ext}`);
        const ppmPath = join(dir, "frame.ppm");
        writeFileSync(inPath, png);

        // Build the ROM through the real CLI.
        const code = await run(
          ["gen", inPath, "-c", consoleId, "--format", "rom", "-o", romPath],
          nodeEnvCapturing(),
        );
        expect(code).toBe(EXIT.OK);

        // Boot it in SameBoy and capture the framebuffer.
        const boot = join(EMU_DIR, `${model}_boot.bin`);
        execFileSync(CAPTURE, [model, boot, romPath, String(FRAMES), ppmPath]);
        const frame = readPpm(readFileSync(ppmPath));

        // The reference: the exact image the ROM encoded, raw-expanded on CGB.
        const result = await gen(png, { console: consoleId, format: "asm", symbol: "demake" });
        const ref = renderCompliant(result.image, consoleId === "gbc");

        let mismatches = 0;
        for (let y = 0; y < ref.height; y += 1) {
          for (let x = 0; x < ref.width; x += 1) {
            const p = (y * frame.w + x) * 3;
            const r = (y * ref.width + x) * 4;
            if (
              frame.data[p] !== ref.data[r] ||
              frame.data[p + 1] !== ref.data[r + 1] ||
              frame.data[p + 2] !== ref.data[r + 2]
            ) {
              mismatches += 1;
            }
          }
        }
        expect(mismatches).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
