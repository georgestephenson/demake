/**
 * Pixel-perfect emulator E2E (doc 10 — the credo).
 *
 * The whole loop, end to end, across a battery of deliberately extreme images:
 * gen → ROM → boot in SameBoy (the accuracy reference) → capture the framebuffer
 * → assert it is byte-identical to demake's DAC reference. SameBoy runs with
 * color correction disabled, so its output is the raw hardware readout (CGB:
 * RGB555 expanded exactly as demake's `expandChannel`; DMG: the exact green
 * ramp), directly comparable to `renderCompliant`.
 *
 * The ROM is assembled here from the same `gen` result the reference uses, so
 * prep runs once per case (the CLI's `--format rom` wiring is covered separately
 * by rom.e2e.test.ts). Self-skips unless RGBDS and the SameBoy capturer are
 * provisioned (`pnpm toolchains && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { encodeRgbaPng, gen, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";

const SAMEBOY_VERSION = "1.0.1";
const EMU_DIR =
  process.env.DEMAKE_EMU_DIR ??
  join(homedir(), ".cache", "demake", "toolchains", `sameboy-${SAMEBOY_VERSION}`);
const CAPTURE = join(EMU_DIR, "capture");
const HARNESS = join(makeNodeEnv().harnessDir() ?? "", "gb", "main.asm");
const FRAMES = 280;

const hasToolchain = makeNodeEnv().which("rgbasm") !== null;
const hasEmu = existsSync(CAPTURE) && existsSync(join(EMU_DIR, "dmg_boot.bin"));
const maybe = hasToolchain && hasEmu && existsSync(HARNESS) ? it : it.skip;

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Deterministic image builder (RGBA PNG). */
function image(
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b] = fn(x, y);
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  }
  return encodeRgbaPng(w, h, d);
}

/** A deterministic LCG for the noise case (no Math.random → reproducible). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Extreme cases: flat, full-screen smooth + full-screen noise (budget + bank 1),
 *  mirror symmetry (flip dedup), per-cell palettes, and the 8×8 minimum. */
const CASES: Record<string, Uint8Array> = {
  flat: image(64, 64, () => [80, 140, 200]),
  "gradient-full": image(160, 144, (x, y) => [clamp((x * 255) / 159), clamp((y * 255) / 143), 128]),
  "noise-full": (() => {
    const r = lcg(7);
    return image(160, 144, () => [(r() * 255) | 0, (r() * 255) | 0, (r() * 255) | 0]);
  })(),
  hmirror: image(64, 64, (x, y) => [(x < 32 ? x : 63 - x) * 8, y * 4, 100]),
  manycolors: image(64, 64, (x, y) => [
    ((x >> 3) * 40) % 256,
    ((y >> 3) * 40) % 256,
    (((x >> 3) + (y >> 3)) * 30) % 256,
  ]),
  tiny: image(8, 8, (x, y) => [x * 32, y * 32, 0]),
};

/** Assemble the harness + generated data into a ROM via the local RGBDS. */
function assemble(dir: string, asm: Uint8Array, isColor: boolean): string {
  writeFileSync(join(dir, "demake.asm"), asm);
  copyFileSync(HARNESS, join(dir, "main.asm"));
  const opts = { cwd: dir, stdio: "pipe" as const };
  execFileSync("rgbasm", ["-o", "main.o", "main.asm"], opts);
  execFileSync("rgblink", ["-o", "out.gb", "main.o"], opts);
  execFileSync(
    "rgbfix",
    isColor ? ["-v", "-C", "-p", "0xFF", "out.gb"] : ["-v", "-p", "0xFF", "out.gb"],
    opts,
  );
  return join(dir, "out.gb");
}

/** Parse a binary PPM (P6). */
function readPpm(bytes: Uint8Array): { w: number; data: Uint8Array } {
  const tokens: string[] = [];
  let pos = 0;
  const ws = (b: number): boolean => b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0d;
  while (tokens.length < 4) {
    while (ws(bytes[pos]!)) pos += 1;
    let s = "";
    while (pos < bytes.length && !ws(bytes[pos]!)) s += String.fromCharCode(bytes[pos++]!);
    tokens.push(s);
  }
  pos += 1;
  return { w: Number(tokens[1]), data: bytes.subarray(pos) };
}

describe("pixel-perfect emulator E2E (needs RGBDS + SameBoy)", () => {
  for (const [consoleId, model] of [
    ["dmg", "dmg"],
    ["gbc", "cgb"],
  ] as const) {
    for (const [name, png] of Object.entries(CASES)) {
      maybe(
        `${consoleId}/${name}: ROM boots in SameBoy and matches the DAC reference`,
        async () => {
          const dir = mkdtempSync(join(tmpdir(), "demake-emu-"));
          try {
            const isColor = consoleId === "gbc";
            // One gen result drives both the ROM and the reference (same prep run).
            const result = await gen(png, {
              console: consoleId,
              format: "asm",
              symbol: "demake",
              prep: { effort: "fast" },
            });
            const rom = assemble(dir, result.artifacts[0]!.bytes, isColor);

            const ppmPath = join(dir, "frame.ppm");
            execFileSync(CAPTURE, [
              model,
              join(EMU_DIR, `${model}_boot.bin`),
              rom,
              String(FRAMES),
              ppmPath,
            ]);
            const frame = readPpm(readFileSync(ppmPath));
            const ref = renderCompliant(result.image, isColor);

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
        },
      );
    }
  }
});
