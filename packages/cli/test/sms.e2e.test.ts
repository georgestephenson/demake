/**
 * Pixel-perfect SMS emulator E2E (doc 10) via libretro / genesis-plus-gx.
 *
 * gen → SMS ROM (WLA-DX) → boot in genesis-plus-gx → capture the framebuffer →
 * assert it matches demake's DAC reference. genesis-plus-gx renders into a 16-bit
 * framebuffer (it has no 32-bit path), so the comparison is in the emulator's
 * native RGB565 precision — the ground truth of what it can display. demake's
 * `expandChannel` (full bit-replication, code*85 for RGB222) matches the core's
 * SMS color pipeline, so the 565-reduced colors agree exactly. Self-skips unless
 * WLA-DX + the libretro runner/core are provisioned (`pnpm toolchains && pnpm
 * emulator`). No Docker.
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

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "genesis_plus_gx_libretro.so");
const FRAMES = 60;

const hasWla = makeNodeEnv().which("wla-z80") !== null && makeNodeEnv().which("wlalink") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasWla && hasEmu ? it : it.skip;

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

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

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const CASES: Record<string, Uint8Array> = {
  gradient: image(96, 96, (x, y) => [clamp(x * 2.6), clamp(y * 2.6), 128]),
  flat: image(64, 64, () => [80, 140, 200]),
  noise: (() => {
    const r = lcg(13);
    return image(72, 72, () => [(r() * 255) | 0, (r() * 255) | 0, (r() * 255) | 0]);
  })(),
};

function nodeEnvCapturing(): CliEnv {
  return { ...makeNodeEnv(), out: () => {}, errOut: () => {}, stdoutIsTTY: () => true };
}

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

describe("pixel-perfect SMS E2E (needs WLA-DX + libretro/genesis-plus-gx)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `sms/${name}: ROM boots in genesis-plus-gx and matches the DAC reference (RGB565)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-sms-e2e-"));
        try {
          const inPath = join(dir, "in.png");
          const romPath = join(dir, "out.sms");
          writeFileSync(inPath, png);

          const code = await run(
            ["gen", inPath, "-c", "sms", "--format", "rom", "-o", romPath],
            nodeEnvCapturing(),
          );
          expect(code).toBe(EXIT.OK);

          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [CORE, romPath, String(FRAMES), ppmPath, dir]);
          const frame = readPpm(readFileSync(ppmPath));

          const result = await gen(png, { console: "sms", format: "bin", symbol: "demake" });
          const ref = renderCompliant(result.image, false);

          // Compare in the core's native RGB565 precision.
          const to565 = (r: number, g: number, b: number): number =>
            ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
          let mismatches = 0;
          for (let y = 0; y < ref.height; y += 1) {
            for (let x = 0; x < ref.width; x += 1) {
              const p = (y * frame.w + x) * 3;
              const r = (y * ref.width + x) * 4;
              const emu = to565(frame.data[p]!, frame.data[p + 1]!, frame.data[p + 2]!);
              const want = to565(ref.data[r]!, ref.data[r + 1]!, ref.data[r + 2]!);
              if (emu !== want) mismatches += 1;
            }
          }
          expect(mismatches).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      60000,
    );
  }
});
